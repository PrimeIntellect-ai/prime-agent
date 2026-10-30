//! Headless e2e for the agents view's hover + click affordances (operator
//! directive 2026-09-29): EVERY row opens on a plain click (inactive
//! saved rows resume, the merged summary row expands its dropdown,
//! expanded child rows open the subagent); hover motions ride along. The same mock also pins the
//! shells poll's one-cycle-in-flight contract.
#![cfg(unix)]
#![warn(clippy::allow_attributes_without_reason)]

mod support;

use std::io::{BufReader, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use pa_tui::agents_view::{run_agents_view, AgentsHeadlessPlan, AgentsStep, AgentsViewUiMode};
use pa_tui::interactive::SessionSelection;
use serde_json::{json, Value};

use support::{read_line, view_options};

/// Mouse tracking is process-global state, so the headless runs serialize through one lock (the
/// click dispatch gates on it; tokio's, so the guard rides the run's awaits).
static RUN_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn roster_row(id: &str, status: &str, summary: &Value) -> Value {
    json!({ "agentId": id, "status": status, "summary": summary })
}

fn parent_summary(id: &str) -> Value {
    json!({
        "sessionId": id,
        "lifecycle": "live",
        "activeSessionId": format!("{id}-live"),
        "sessionFile": format!("/tmp/{id}.jsonl"),
        "runtimeKind": "top-level",
        "sessionName": format!("{id} name"),
        "messageCount": 2,
        "rlmDepth": 0,
    })
}

fn child_summary(id: &str, parent: &str, name: &str) -> Value {
    json!({
        "sessionId": id,
        "lifecycle": "live",
        "activeSessionId": format!("{id}-live"),
        "sessionFile": format!("/tmp/{id}.jsonl"),
        "runtimeKind": "subagent",
        "rlmChildId": format!("child-{id}"),
        "parentActiveSessionId": format!("{parent}-live"),
        "parentSessionId": parent,
        "parentSessionPath": format!("/tmp/{parent}.jsonl"),
        "sessionName": name,
        "messageCount": 1,
        "rlmDepth": 1,
    })
}

/// One saved-catalog row (TS `serializeSavedSessionInfo`'s shape).
fn saved_row(path: &str, id: &str, name: &str) -> Value {
    json!({
        "path": path,
        "id": id,
        "cwd": "/tmp",
        "rlmDepth": 0,
        "created": "2024-01-01T00:00:00.000Z",
        "modified": "2024-01-01T00:00:00.000Z",
        "messageCount": 3,
        "name": name,
    })
}

/// The shells-poll probe: the first `list_kernel_bash` answers only after a hold longer than the
/// poll interval; a request arriving while another is still unanswered means the poll stacked.
#[derive(Default)]
struct ShellsProbe {
    requests: AtomicUsize,
    unanswered: AtomicUsize,
    overlapped: AtomicBool,
}

fn shells_reply(running: usize) -> Value {
    let activities: Vec<Value> = (0..running)
        .map(|index| json!({"id": format!("shell-{index}"), "command": "sleep", "status": "running"}))
        .collect();
    json!({ "activities": activities })
}

struct MockSupervisor {
    listener: UnixListener,
    roster: Vec<Value>,
    /// `Some` advertises the kernel-bash capability and serves the probe's shells replies.
    shells: Option<Arc<ShellsProbe>>,
}

impl MockSupervisor {
    fn bind(socket: &std::path::Path) -> Self {
        MockSupervisor {
            listener: UnixListener::bind(socket).expect("bind mock socket"),
            roster: vec![
                roster_row("p", "idle", &parent_summary("p")),
                roster_row("c", "running", &child_summary("c", "p", "worker one")),
            ],
            shells: None,
        }
    }

    fn serve(self) {
        let (stream, _) = self.listener.accept().expect("accept view connection");
        stream
            .set_read_timeout(Some(Duration::from_millis(100)))
            .expect("read timeout");
        let write_stream = stream.try_clone().expect("clone socket");
        let mut writer = write_stream;
        let mut reader = BufReader::new(stream);
        let capabilities: &[&str] = if self.shells.is_some() {
            &["kernel_bash_activity"]
        } else {
            &[]
        };
        let hello = json!({
            "type": "daemon_hello",
            "protocol": { "name": "prime-agent.daemon", "version": 7 },
            "serverCapabilities": capabilities,
        });
        write_line(&mut writer, &hello);
        loop {
            let Some(line) = read_line(&mut reader) else {
                return;
            };
            let Ok(envelope) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            let id = envelope
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let command = envelope.get("command").cloned().unwrap_or(Value::Null);
            let command_type = command
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            match command_type.as_str() {
                "roster_subscribe" => {
                    respond(
                        &mut writer,
                        id,
                        "roster_subscribe",
                        &json!({ "roster": self.roster }),
                    );
                }
                "list_saved_sessions" => {
                    respond(
                        &mut writer,
                        id,
                        "list_saved_sessions",
                        &json!({ "sessions": [saved_row("/tmp/sessions/old.jsonl", "old", "archived run")] }),
                    );
                }
                "roster_unsubscribe" => {
                    respond(&mut writer, id, "roster_unsubscribe", &Value::Null);
                }
                "list_kernel_bash" if self.shells.is_some() => {
                    let probe = Arc::clone(self.shells.as_ref().expect("the probe"));
                    if probe.unanswered.fetch_add(1, Ordering::SeqCst) > 0 {
                        probe.overlapped.store(true, Ordering::SeqCst);
                    }
                    // The unanswered count drops before the reply is written: the client may send
                    // its next request the moment the reply lands.
                    if probe.requests.fetch_add(1, Ordering::SeqCst) == 0 {
                        let mut writer = writer.try_clone().expect("clone socket");
                        let id = id.to_string();
                        std::thread::spawn(move || {
                            std::thread::sleep(Duration::from_millis(2700));
                            probe.unanswered.fetch_sub(1, Ordering::SeqCst);
                            respond(&mut writer, &id, "list_kernel_bash", &shells_reply(1));
                        });
                    } else {
                        probe.unanswered.fetch_sub(1, Ordering::SeqCst);
                        respond(&mut writer, id, "list_kernel_bash", &shells_reply(2));
                    }
                }
                other => {
                    respond_failure(&mut writer, id, other, "not handled by the mock");
                }
            }
        }
    }
}

fn write_line(writer: &mut UnixStream, value: &Value) {
    // The probe's held reply writes from its own thread: one line at a time, never interleaved.
    static WRITE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _guard = WRITE_LOCK.lock().expect("write lock");
    let mut line = serde_json::to_string(value).expect("serialize line");
    line.push('\n');
    writer.write_all(line.as_bytes()).expect("write");
    writer.flush().expect("flush");
}

fn respond(writer: &mut UnixStream, id: &str, command: &str, data: &Value) {
    write_line(
        writer,
        &json!({
            "id": id,
            "type": "response",
            "command": command,
            "success": true,
            "data": data,
        }),
    );
}

fn respond_failure(writer: &mut UnixStream, id: &str, command: &str, error: &str) {
    write_line(
        writer,
        &json!({
            "id": id,
            "type": "response",
            "command": command,
            "success": false,
            "error": error,
        }),
    );
}

/// Run one headless plan and return the outcome. Holds the run lock: the click dispatch gates on
/// the process-global tracking state.
async fn run_plan(steps: Vec<AgentsStep>) -> pa_tui::agents_view::AgentsViewOutcome {
    run_plan_with(steps, |mock| mock).await
}

async fn run_plan_with(
    steps: Vec<AgentsStep>,
    configure: impl FnOnce(MockSupervisor) -> MockSupervisor,
) -> pa_tui::agents_view::AgentsViewOutcome {
    let _guard = RUN_LOCK.lock().await;
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("agents-view.sock");
    let mock = configure(MockSupervisor::bind(&socket));
    let server = std::thread::spawn(move || mock.serve());
    let plan = AgentsHeadlessPlan {
        steps,
        width: 120,
        height: 36,
    };
    let outcome = run_agents_view(
        view_options(&socket),
        AgentsViewUiMode::Headless(plan),
        None,
    )
    .await
    .expect("the agents view run")
    .outcome;
    let _ = server.join();
    outcome
}

/// The settled roster's frames: the plan holds until the merged summary line and the saved
/// catalog's row both render (the catalog lands on the event cadence).
async fn settled_frames(needle: &str) -> Vec<String> {
    run_plan(vec![
        AgentsStep::WaitSettle { timeout_ms: 2500 },
        AgentsStep::WaitRender {
            needle: needle.to_string(),
            timeout_ms: 8000,
        },
    ])
    .await
    .frames
}

/// The last frame holding a needle and its row.
fn locate_row(frames: &[String], needle: &str) -> Option<usize> {
    frames
        .iter()
        .filter_map(|frame| {
            frame
                .split('\n')
                .position(|row| row.contains(needle))
                .map(|row| (row, frame))
        })
        .next_back()
        .map(|(row, _)| row)
}

/// The `?1003` buttonless motion report (the hover affordance's input), one-based cells like the
/// terminal sends.
fn motion(col: usize, row: usize) -> String {
    format!("\x1b[<35;{};{}M", col + 1, row + 1)
}

/// A plain click on the INACTIVE saved row opens it: the resume selection — every row is clickable,
/// the archived ones included.
#[tokio::test]
async fn a_click_on_an_inactive_row_opens_it() {
    let frames = settled_frames("archived run").await;
    let row = locate_row(&frames, "archived run").expect("the inactive row renders");
    let outcome = run_plan(vec![
        AgentsStep::WaitSettle { timeout_ms: 2500 },
        AgentsStep::WaitRender {
            needle: "archived run".to_string(),
            timeout_ms: 8000,
        },
        AgentsStep::Click { row, col: 4 },
    ])
    .await;
    assert_eq!(
        outcome.selection,
        Some(SessionSelection::Resume(PathBuf::from(
            "/tmp/sessions/old.jsonl"
        ))),
        "the click resumed the saved session"
    );
}

/// A plain click on the merged `N subagents · M running` row EXPANDS the dropdown — the toggle, not
/// an open: the frame renders the child rows and the run keeps running with no selection.
#[tokio::test]
async fn a_click_on_the_merged_summary_expands_the_dropdown() {
    let frames = settled_frames("1 subagent \u{b7}").await;
    let row = locate_row(&frames, "1 subagent \u{b7}").expect("the merged line renders");
    let outcome = run_plan(vec![
        AgentsStep::WaitSettle { timeout_ms: 2500 },
        AgentsStep::WaitRender {
            needle: "1 subagent \u{b7}".to_string(),
            timeout_ms: 8000,
        },
        AgentsStep::Click { row, col: 4 },
        AgentsStep::WaitRender {
            needle: "worker one".to_string(),
            timeout_ms: 5000,
        },
    ])
    .await;
    let last = outcome.frames.last().expect("a frame after the click");
    assert!(
        last.contains("worker one"),
        "the click expanded the dropdown: {last}"
    );
    assert!(
        outcome.selection.is_none(),
        "the summary click toggles the dropdown, never an open"
    );
}

/// A plain click on the expanded CHILD row opens the subagent — the Enter action on the drilled-in
/// row.
#[tokio::test]
async fn a_click_on_the_expanded_child_opens_the_subagent() {
    let frames = settled_frames("1 subagent \u{b7}").await;
    let summary = locate_row(&frames, "1 subagent \u{b7}").expect("the merged line renders");
    let outcome = run_plan(vec![
        AgentsStep::WaitSettle { timeout_ms: 2500 },
        AgentsStep::WaitRender {
            needle: "1 subagent \u{b7}".to_string(),
            timeout_ms: 8000,
        },
        AgentsStep::Click {
            row: summary,
            col: 4,
        },
        AgentsStep::WaitRender {
            needle: "worker one".to_string(),
            timeout_ms: 5000,
        },
    ])
    .await;
    let child = locate_row(&outcome.frames, "worker one").expect("the child renders expanded");
    let outcome = run_plan(vec![
        AgentsStep::WaitSettle { timeout_ms: 2500 },
        AgentsStep::WaitRender {
            needle: "1 subagent \u{b7}".to_string(),
            timeout_ms: 8000,
        },
        AgentsStep::Click {
            row: summary,
            col: 4,
        },
        AgentsStep::WaitRender {
            needle: "worker one".to_string(),
            timeout_ms: 5000,
        },
        AgentsStep::Click { row: child, col: 4 },
    ])
    .await;
    assert_eq!(
        outcome.selection,
        Some(SessionSelection::Attach("c-live".to_string())),
        "the click opened the subagent row"
    );
}

/// The `?1003` hover motions ride the rows without disturbing the click grammar: motions across the
/// merged line, the child rows, and the headings, then a plain click — the subagent still opens.
#[tokio::test]
async fn hover_motions_never_disturb_the_agents_view_click() {
    let frames = settled_frames("1 subagent \u{b7}").await;
    let summary = locate_row(&frames, "1 subagent \u{b7}").expect("the merged line renders");
    let outcome = run_plan(vec![
        AgentsStep::WaitSettle { timeout_ms: 2500 },
        AgentsStep::WaitRender {
            needle: "1 subagent \u{b7}".to_string(),
            timeout_ms: 8000,
        },
        AgentsStep::Click {
            row: summary,
            col: 4,
        },
        AgentsStep::WaitRender {
            needle: "worker one".to_string(),
            timeout_ms: 5000,
        },
    ])
    .await;
    let child = locate_row(&outcome.frames, "worker one").expect("the child renders expanded");
    let outcome = run_plan(vec![
        AgentsStep::WaitSettle { timeout_ms: 2500 },
        AgentsStep::WaitRender {
            needle: "1 subagent \u{b7}".to_string(),
            timeout_ms: 8000,
        },
        // Hover motions across the parent row, the merged line, the heading, and the expanded child
        // (the buttonless reports the real terminal sends under any-event tracking).
        AgentsStep::Mouse(motion(4, 0)),
        AgentsStep::Mouse(motion(4, summary)),
        AgentsStep::Mouse(motion(2, summary - 1)),
        AgentsStep::Mouse(motion(4, summary)),
        AgentsStep::Click {
            row: summary,
            col: 4,
        },
        AgentsStep::WaitRender {
            needle: "worker one".to_string(),
            timeout_ms: 5000,
        },
        AgentsStep::Mouse(motion(4, child)),
        AgentsStep::Click { row: child, col: 4 },
    ])
    .await;
    assert_eq!(
        outcome.selection,
        Some(SessionSelection::Attach("c-live".to_string())),
        "the click opened the subagent after the hover motions"
    );
}

/// The shells poll never stacks: with the first `list_kernel_bash` held past the poll interval, the
/// next request waits for it to land, and the line reaches the second answer's count.
#[tokio::test]
async fn a_slow_shells_read_never_stacks_the_poll() {
    let probe = Arc::new(ShellsProbe::default());
    let outcome = run_plan_with(
        vec![AgentsStep::WaitRender {
            needle: "$ 2 shells".to_string(),
            timeout_ms: 10_000,
        }],
        |mut mock| {
            mock.roster = vec![roster_row("p", "idle", &parent_summary("p"))];
            mock.shells = Some(Arc::clone(&probe));
            mock
        },
    )
    .await;
    assert!(
        outcome
            .frames
            .iter()
            .any(|frame| frame.contains("$ 2 shells")),
        "the poll re-armed after the held read landed"
    );
    assert!(
        !probe.overlapped.load(Ordering::SeqCst),
        "a list_kernel_bash arrived while another was unanswered"
    );
}

/// A cycle held across a session handoff belongs to the returning view, not the old UI channel.
#[tokio::test]
#[expect(
    clippy::too_many_lines,
    reason = "the inline mock daemon sits next to the two view runs it scripts"
)]
async fn a_held_shells_read_survives_the_agents_view_handoff() {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt};

    let _guard = RUN_LOCK.lock().await;
    let dir = tempfile::TempDir::new().expect("temp dir");
    let socket = dir.path().join("handoff.sock");
    let listener = tokio::net::UnixListener::bind(&socket).expect("bind mock socket");
    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.expect("accept view connection");
        let (read, mut write) = stream.into_split();
        let hello = json!({
            "type": "daemon_hello",
            "protocol": { "name": "prime-agent.daemon", "version": 7 },
            "serverCapabilities": ["kernel_bash_activity"],
        });
        write
            .write_all(format!("{hello}\n").as_bytes())
            .await
            .unwrap();
        let mut lines = tokio::io::BufReader::new(read).lines();
        let mut shells_requests = 0;
        let mut heartbeat_requests = 0;
        let mut held_shell = None;
        let mut held_catalog = None;
        while let Some(line) = lines.next_line().await.unwrap() {
            if line.is_empty() {
                break;
            }
            let envelope: Value = serde_json::from_str(&line).unwrap();
            let id = envelope["id"].as_str().unwrap().to_string();
            let command = envelope["command"]["type"].as_str().unwrap();
            let mut replies = Vec::new();
            match command {
                "roster_subscribe" => replies.push((
                    id,
                    json!({
                        "roster": [roster_row("p", "idle", &parent_summary("p"))],
                    }),
                )),
                "list_saved_sessions" => held_catalog = Some(id),
                "list_kernel_bash" => {
                    shells_requests += 1;
                    if shells_requests == 1 {
                        held_shell = Some(id);
                    } else {
                        replies.push((id, shells_reply(2)));
                    }
                }
                "heartbeats_list" => {
                    heartbeat_requests += 1;
                    replies.push((id, json!({"heartbeats": []})));
                    if heartbeat_requests == 2 {
                        replies.push((
                            held_shell.take().expect("the first view issued its poll"),
                            shells_reply(1),
                        ));
                    }
                }
                "roster_unsubscribe" => replies.push((id, Value::Null)),
                other => panic!("unexpected command: {other}"),
            }
            // The first view can open only after the server observed its unanswered shells read.
            if let (true, Some(id)) = (shells_requests > 0, held_catalog.as_ref()) {
                replies.push((
                    id.clone(),
                    json!({"sessions": [saved_row(
                        "/tmp/sessions/old.jsonl", "old", "archived run",
                    )]}),
                ));
                held_catalog = None;
            }
            for (id, data) in replies {
                let response_command = if data.get("activities").is_some() {
                    "list_kernel_bash"
                } else if data.get("sessions").is_some() {
                    "list_saved_sessions"
                } else {
                    command
                };
                let reply = json!({
                    "type": "response", "id": id, "command": response_command,
                    "success": true, "data": data,
                });
                write
                    .write_all(format!("{reply}\n").as_bytes())
                    .await
                    .unwrap();
            }
        }
        shells_requests
    });
    let first = run_agents_view(
        view_options(&socket),
        AgentsViewUiMode::Headless(AgentsHeadlessPlan {
            steps: vec![
                AgentsStep::WaitRender {
                    needle: "archived run".to_string(),
                    timeout_ms: 2500,
                },
                AgentsStep::Key("home".to_string()),
                AgentsStep::Key("enter".to_string()),
            ],
            width: 120,
            height: 36,
        }),
        None,
    )
    .await
    .expect("the first view opens its session");
    assert_eq!(
        first.outcome.selection,
        Some(SessionSelection::Attach("p-live".to_string()))
    );
    let second = run_agents_view(
        view_options(&socket),
        AgentsViewUiMode::Headless(AgentsHeadlessPlan {
            steps: vec![AgentsStep::WaitRender {
                needle: "$ 1 shell".to_string(),
                timeout_ms: 2500,
            }],
            width: 120,
            height: 36,
        }),
        Some(
            first
                .link
                .expect("the handoff retains the roster connection"),
        ),
    )
    .await
    .expect("the returning view consumes the held cycle");
    assert!(second
        .outcome
        .frames
        .iter()
        .any(|frame| frame.contains("$ 1 shell")));
    assert_eq!(
        server.await.unwrap(),
        1,
        "re-entry must not issue a second shells request"
    );
}
