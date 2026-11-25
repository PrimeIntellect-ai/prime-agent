//! Print mode over a running daemon (TS main.ts `useDaemonClient` +
//! `runPrintModeWithConnection`): the daemon hosts the session and holds
//! its lease, so family peers list and message it while the run is in
//! flight. The run creates a client-owned daemon session for the selected
//! session, prompts it, waits for headless completion (RLM quiescence
//! included), and prints the same output the daemonless runtime prints.

use pa_tui::daemon_client::{DaemonClient, DaemonClientEvent, RequestRejected};
use pa_types::daemon::{DaemonCommand, PromptInput};
use serde_json::{json, Map, Value};
use tokio::sync::mpsc::UnboundedReceiver;

use crate::mode::{AppMode, RunOptions};

/// Turn-long requests carry no timer: the response or the closed daemon
/// connection ends the wait.
const NO_TIMEOUT_MS: u64 = u64::MAX;

/// Run print mode through the daemon on the resolved socket. `None` when
/// no current daemon answers: the caller runs daemonless.
///
/// # Errors
///
/// Returns the failure text when the daemon refuses the session or a
/// prompt, or the connection drops mid-run.
pub(crate) fn run_print_mode_via_daemon(options: &RunOptions) -> Result<Option<i32>, String> {
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(|error| error.to_string())?;
    rt.block_on(async {
        let socket = crate::config::resolve_daemon_socket_path(options.daemon_socket.as_deref());
        let Ok((client, mut events)) = DaemonClient::connect(&socket).await else {
            return Ok(None);
        };
        if !crate::interactive_mode::is_current_daemon(client.hello()) {
            client.close();
            return Ok(None);
        }
        crate::telemetry_notice::print_if_due(&options.config);
        let (_cwd, create) = crate::print_runtime::headless_daemon_create(options)?;
        let session_path = match &create {
            DaemonCommand::Create { session_path, .. } => session_path.clone(),
            _ => None,
        };
        // Ctrl-C or SIGTERM from here on ends the run through the owned-session
        // teardown below, so the daemon stops the worker at once instead of
        // after the disconnect grace. A signal during the create still waits
        // for the create's answer: the teardown needs the spawned session's id.
        let mut interrupt = std::pin::pin!(interrupted());
        let mut create = std::pin::pin!(client.request_ok(create));
        let mut signal = None;
        let created = tokio::select! {
            created = &mut create => created,
            code = &mut interrupt => {
                signal = Some(code);
                tokio::select! {
                    created = create => created,
                    code = interrupted() => {
                        client.close();
                        return Ok(Some(code));
                    }
                }
            }
        };
        // B-11: the run-owned session never takes over a file a live daemon
        // worker already hosts. The daemon refuses the client-owned create
        // atomically (TS `assertWorkerCreateOwner`).
        let summary = match created {
            Ok(summary) => summary,
            Err(_) if signal.is_some() => {
                client.close();
                return Ok(signal);
            }
            Err(error) => {
                let refusal = describe_live_session_refusal(&client, &error, session_path).await;
                client.close();
                return Err(refusal.unwrap_or_else(|| format!("{error:#}")));
            }
        };
        let active_session_id = summary
            .get("activeSessionId")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        // Attach, prompt, and settle the session, then print the result (TS
        // `runPrintModeWithConnectionInternal`).
        let run = async {
            let json_mode = options.app_mode == AppMode::Json;
            let failed = |error: anyhow::Error| format!("{error:#}");
            let attached = client
                .request_ok(DaemonCommand::Attach {
                    id: None,
                    active_session_id: active_session_id.clone(),
                    client_id: None,
                    capabilities: None,
                    resume_cursor: None,
                    telemetry_disabled: None,
                    recovery_config: None,
                    env: None,
                    launch_env: None,
                    rest: Map::default(),
                })
                .await
                .map_err(failed)?;
            let goal_updated_at_start = goal_of(&attached["snapshot"]["state"]).updated_at;
            let mut refine_failed = false;
            if json_mode {
                let header = client
                    .request_ok(DaemonCommand::GetSessionHeader {
                        id: None,
                        active_session_id: active_session_id.clone(),
                        rest: Map::default(),
                    })
                    .await
                    .map_err(failed)?;
                if let Some(header) = header.get("header").filter(|header| !header.is_null()) {
                    println!("{header}");
                }
            }
            // The `@file` image attachments ride the initial prompt only.
            let prompts = options
                .initial_message
                .iter()
                .map(|prompt| (prompt, options.initial_images.as_slice()))
                .chain(options.messages.iter().map(|prompt| (prompt, &[][..])));
            for (prompt, images) in prompts {
                let command = DaemonCommand::PromptAndWait {
                    id: None,
                    active_session_id: active_session_id.clone(),
                    message: prompt.clone(),
                    input: PromptInput {
                        content: None,
                        images: (!images.is_empty()).then(|| {
                            images
                                .iter()
                                .map(|image| {
                                    json!({ "type": "image", "data": image.data, "mimeType": image.mime_type })
                                })
                                .collect()
                        }),
                        streaming_behavior: None,
                        queue_if_busy: None,
                        expand_prompt_templates: None,
                        source: None,
                        agent_message_id: None,
                        custom_message: None,
                        queue_key: None,
                        prefix_messages: None,
                        admission_id: None,
                        rlm_notice_nonce: None,
                    },
                    rest: Map::default(),
                };
                let prompted = relay_events_until(
                    client.request_ok_with_timeout(command, NO_TIMEOUT_MS),
                    &mut events,
                    json_mode,
                    &active_session_id,
                    &mut refine_failed,
                )
                .await;
                // A failed session command or turn rejects the prompt wait:
                // the raw error goes to stderr and the run exits 1 with no
                // later prompts, like the daemonless run.
                if let Err(error) = prompted {
                    let Some(rejected) = error.downcast_ref::<RequestRejected>() else {
                        return Err(failed(error));
                    };
                    eprintln!("{}", rejected.message);
                    return Ok(1);
                }
            }
            // The daemonless print's #2270 contract: every admitted descendant
            // settles before the terminal result is read.
            let status = relay_events_until(
                client.request_ok_with_timeout(
                    DaemonCommand::WaitForHeadlessCompletion {
                        id: None,
                        active_session_id: active_session_id.clone(),
                        wait_for_rlm_quiescence: Some(true),
                        rest: Map::default(),
                    },
                    NO_TIMEOUT_MS,
                ),
                &mut events,
                json_mode,
                &active_session_id,
                &mut refine_failed,
            )
            .await
            .map_err(failed)?;
            let status: pa_core::autonomous::AgentAutonomousStatus =
                serde_json::from_value(status).map_err(|error| error.to_string())?;
            let mut exit_code = 0;
            if !json_mode {
                let state = client
                    .request_ok(DaemonCommand::GetConnectionState {
                        id: None,
                        active_session_id: active_session_id.clone(),
                        rest: Map::default(),
                    })
                    .await
                    .map_err(failed)?;
                crate::print_runtime::emit_goal_cap_result(
                    &goal_of(&state),
                    goal_updated_at_start,
                    &mut exit_code,
                );
                let messages = client
                    .request_ok(DaemonCommand::GetMessages {
                        id: None,
                        active_session_id: active_session_id.clone(),
                        page: None,
                        capabilities: None,
                        rest: Map::default(),
                    })
                    .await
                    .map_err(failed)?;
                let messages: Vec<pa_types::session::AgentMessage> = messages
                    .get("messages")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(|message| serde_json::from_value(message.clone()).ok())
                    .collect();
                crate::print_runtime::emit_text_terminal_result(&messages, &mut exit_code);
            }
            if let Some(stderr) = crate::headless_autonomous::autonomous_exit_stderr(
                &status,
                pa_core::autonomous::now_millis(),
            ) {
                eprintln!("{stderr}");
                exit_code = 1;
            }
            if refine_failed {
                exit_code = 1;
            }
            Ok(exit_code)
        };
        let exit = if let Some(code) = signal {
            Ok(code)
        } else {
            tokio::select! {
                exit = run => exit,
                code = &mut interrupt => Ok(code),
            }
        };
        // The run's session ends with it. A further signal skips the wait.
        tokio::select! {
            _ = client.request(DaemonCommand::CompleteOwnedSession {
                id: None,
                active_session_id: active_session_id.clone(),
                rest: Map::default(),
            }) => {}
            _ = interrupted() => {}
        }
        client.close();
        exit.map(Some)
    })
}

/// The first Ctrl-C (SIGINT) or, on unix, SIGTERM, as the shell's exit code
/// for it (TS print mode's signal handlers).
async fn interrupted() -> i32 {
    let interrupt = async { tokio::signal::ctrl_c().await.map(|()| 130) };
    #[cfg(unix)]
    let terminate = async {
        let mut terminate =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
        terminate.recv().await;
        Ok::<_, std::io::Error>(143)
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<std::io::Result<i32>>();
    tokio::select! {
        Ok(code) = interrupt => code,
        Ok(code) = terminate => code,
        else => std::future::pending().await,
    }
}

/// The session goal in a connection state (`attach` snapshot or
/// `get_connection_state`).
fn goal_of(state: &Value) -> pa_types::goal::GoalState {
    serde_json::from_value(state["goal"].clone())
        .unwrap_or_else(|_| pa_types::goal::empty_goal_state())
}

/// The descriptive B-11 refusal for a create the daemon refused because a
/// live worker hosts the file: the roster names the holder (the TUI's
/// `describe_session_open_failure` order). `None` for any other failure.
async fn describe_live_session_refusal(
    client: &DaemonClient,
    error: &anyhow::Error,
    session_path: Option<String>,
) -> Option<String> {
    let rejected = error.downcast_ref::<RequestRejected>()?;
    pa_tui::session_open_error::owner_from_refusal(&rejected.message)?;
    let list = client
        .request_ok(DaemonCommand::List {
            id: None,
            all: None,
            cwd: None,
            session_dir: None,
            include_client_owned: None,
            rest: Map::default(),
        })
        .await
        .ok()?;
    live_session_refusal(Some(&list), std::path::Path::new(&session_path?))
}

/// The refusal for a session file a live daemon worker already hosts, from a
/// daemon `list` answer: the descriptive message (operator-directed) points
/// at attaching to the live session instead of reopening its file.
pub(crate) fn live_session_refusal(
    list: Option<&serde_json::Value>,
    session_path: &std::path::Path,
) -> Option<String> {
    let target = pa_daemon::lease::canonical_session_path(session_path);
    let row = list
        .and_then(|data| data.get("sessions"))
        .and_then(serde_json::Value::as_array)?
        .iter()
        .find(|row| {
            row.get("sessionFile")
                .and_then(serde_json::Value::as_str)
                .is_some_and(|file| {
                    pa_daemon::lease::canonical_session_path(std::path::Path::new(file)) == target
                })
        })?;
    if let Some(holder) =
        pa_tui::session_open_error::holder_from_roster(std::slice::from_ref(row), &target)
    {
        return Some(pa_tui::session_open_error::already_active_error(
            &holder, &target,
        ));
    }
    let active_session_id = row
        .get("activeSessionId")
        .or_else(|| row.get("id"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    Some(format!(
        "Session is already active in {active_session_id}: {}",
        target.display()
    ))
}

/// Await one request while relaying the session's streamed events: json
/// mode prints each one (TS writes every `session_event`), text mode
/// drops them but reports a failed refinement. A `/refine` command's
/// `refine_failed` (source `user`) sets `refine_failed`, which fails the run
/// like the daemonless run; a model-requested or compaction-triggered
/// refinement's failure is only reported. The worker flushes a turn's
/// events before its response, and the RLM quiescence barrier holds for
/// the refinement child, so every event the request produced is relayed
/// when it returns.
async fn relay_events_until<T>(
    request: impl std::future::Future<Output = T>,
    events: &mut UnboundedReceiver<DaemonClientEvent>,
    json_mode: bool,
    active_session_id: &str,
    refine_failed: &mut bool,
) -> T {
    let mut request = std::pin::pin!(request);
    loop {
        tokio::select! {
            biased;
            Some(event) = events.recv() => {
                let DaemonClientEvent::SessionEvent { active_session_id: from, event, .. } = event else {
                    continue;
                };
                if from != active_session_id {
                    continue;
                }
                if json_mode {
                    println!("{event}");
                }
                if event["type"] == "refine_failed" {
                    if !json_mode {
                        crate::print_runtime::emit_refinement_failure(
                            event["error"].as_str().unwrap_or_default(),
                        );
                    }
                    *refine_failed |=
                        event["source"] == pa_core::session_engine::refine::RefinementSource::User.as_str();
                }
            }
            result = &mut request => return result,
        }
    }
}
