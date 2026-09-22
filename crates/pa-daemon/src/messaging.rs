//! Supervisor `send_message` arm: agent-to-agent message routing.
//!
//! Port of the `send_message` block in `modes/daemon/daemon-supervisor.ts`:
//! resolve the source and target workers, refuse self-targeting, then route
//! `worker_deliver_message` to the target with sender info from the source
//! session (agent origin) or the sending client (CLI origin). A target that
//! is not resident is woken from the saved-session catalog: the selector
//! resolves to a session file (`session_catalog.rs`), a resident worker
//! hosting the file is reused, and otherwise a new worker spawns over it
//! (the headless resume machinery). The TS family-reach assertion needs the
//! session family catalog, which the thin supervisor does not keep yet; it
//! stays deferred with it.

use std::sync::Arc;

use anyhow::{anyhow, Result};
use pa_types::daemon::{DaemonCommand, DaemonWorkerCommand};
use serde_json::{json, Value};

use crate::protocol::{response_failure, response_success, DaemonResponse};
use crate::registry::ResidentWorker;
use crate::supervisor::Supervisor;

/// Worker round-trip budget for the sender-summary read and the delivery
/// route (TS `WORKER_REQUEST_TIMEOUT_MS`).
const WORKER_REQUEST_TIMEOUT_MS: u64 = 30_000;

impl Supervisor {
    /// `send_message`: route to the target worker as `worker_deliver_message`.
    /// An unknown target is not final: the supervisor wakes the saved session
    /// the selector names (catalog resolve + worker reuse) before giving up
    /// with the TS unknown-session error.
    pub(crate) async fn handle_send_message(
        self: &Arc<Self>,
        command_id: &str,
        client_id: &str,
        command: &DaemonCommand,
    ) -> DaemonResponse {
        let DaemonCommand::SendMessage {
            target_active_session_id,
            message,
            from_active_session_id,
            delivery_mode,
            ..
        } = command
        else {
            return response_failure(Some(command_id), "send_message", "invalid command", None);
        };
        let fail = |error: String| response_failure(Some(command_id), "send_message", &error, None);
        // Source first, like the TS supervisor: an unknown source answers
        // with the same unknown-session error as an unknown target.
        let source = match from_active_session_id {
            Some(source) => match self.registry.resolve(source).await {
                Ok(resident) => Some(resident),
                Err(_) => return fail(format!("Unknown active session: {source}")),
            },
            None => None,
        };
        // The source summary, once read (the wake reads it for its scope;
        // the sender endpoint reuses it).
        let mut source_summary: Option<Value> = None;
        let target = match self.registry.resolve(target_active_session_id).await {
            Ok(resident) => resident,
            Err(error) => {
                // The wake scope needs the source summary (its cwd filters
                // the catalog's local pass, TS `source?.summary.cwd`); a
                // wake is the only path that reads it before the
                // self-target guard, and a woken target is never the
                // source, so the guard's error precedence is unchanged.
                let wake_source = match &source {
                    Some(source) => match self.source_worker_summary(source).await {
                        Ok(summary) => Some((Arc::clone(source), summary)),
                        Err(error) => return fail(format!("{error:#}")),
                    },
                    None => None,
                };
                let woken_summary = wake_source.as_ref().map(|(_, summary)| summary.clone());
                match self
                    .wake_saved_target(
                        &error,
                        target_active_session_id,
                        wake_source
                            .as_ref()
                            .map(|(resident, summary)| (resident, summary)),
                    )
                    .await
                {
                    WakeOutcome::Woken(resident) => {
                        source_summary = woken_summary;
                        resident
                    }
                    WakeOutcome::Unknown => {
                        return fail(format!(
                            "Unknown active session: {target_active_session_id}"
                        ))
                    }
                    WakeOutcome::Failed(error) => return fail(error),
                }
            }
        };
        if source
            .as_ref()
            .is_some_and(|source| Arc::ptr_eq(source, &target))
        {
            return fail("Agent messaging cannot target the sending session".to_string());
        }
        let sender = match &source {
            Some(source) => {
                // The wake already read the summary for its scope; every
                // other path reads it here (the TS sender endpoint comes
                // from the roster summary).
                let summary = match source_summary.take() {
                    Some(summary) => summary,
                    None => match self.source_worker_summary(source).await {
                        Ok(summary) => summary,
                        Err(error) => return fail(format!("{error:#}")),
                    },
                };
                sender_endpoint_from_summary(&summary, client_id)
            }
            // CLI origin: the TS worker attributes client-sent messages to
            // the client id (`createAgentSessionMessageSender`).
            None => json!({ "clientId": client_id }),
        };
        let delivery = DaemonWorkerCommand::WorkerDeliverMessage {
            id: None,
            target_active_session_id: target.worker_id.clone(),
            message: message.clone(),
            sender,
            delivery_mode: delivery_mode.clone(),
            rest: Default::default(),
        };
        let payload = match serde_json::to_value(&delivery) {
            Ok(payload) => payload,
            Err(error) => return fail(format!("invalid delivery command: {error}")),
        };
        let response = self
            .route_command(
                &target,
                "worker_deliver_message",
                payload,
                WORKER_REQUEST_TIMEOUT_MS,
            )
            .await;
        match response {
            Ok(response) if response.success => {
                response_success(Some(command_id), "send_message", response.data)
            }
            Ok(response) => fail(
                response
                    .error
                    .unwrap_or_else(|| "delivery failed".to_string()),
            ),
            Err(error) => fail(format!("{error:#}")),
        }
    }

    /// The send source's live session summary (`get_state`), strict: the
    /// read's error fails the send (the roster's own `worker_summary`
    /// downgrades an unreachable worker to a recovering row instead).
    async fn source_worker_summary(&self, resident: &Arc<ResidentWorker>) -> Result<Value> {
        let state = self
            .route_command(resident, "get_state", json!({}), WORKER_REQUEST_TIMEOUT_MS)
            .await?;
        if !state.success {
            return Err(anyhow!(
                "{}",
                state
                    .error
                    .unwrap_or_else(|| "source state unavailable".to_string())
            ));
        }
        state
            .data
            .ok_or_else(|| anyhow!("source session state unavailable"))
    }

    /// Wake the saved session an unknown target selector names (the TS
    /// `send_message` wake block): catalog-resolve the selector, reuse a
    /// resident worker that already hosts the file, or spawn one over it.
    /// `Unknown` keeps the caller's unknown-session error; `Failed` carries
    /// the wake's own error (a catalog ambiguity outranks the miss, like
    /// the TS `Ambiguous session selector` propagation).
    async fn wake_saved_target(
        self: &Arc<Self>,
        resolve_error: &anyhow::Error,
        selector: &str,
        source: Option<(&Arc<ResidentWorker>, &Value)>,
    ) -> WakeOutcome {
        let rendered = resolve_error.to_string();
        if !rendered.starts_with("Unknown active session:") {
            return WakeOutcome::Failed(rendered);
        }
        // The catalog scope: the source session's cwd and session dir when
        // the send is agent-origin, the supervisor's defaults otherwise
        // (TS `source?.summary.cwd ?? defaultSessionConfig.cwd`).
        let cwd = source
            .and_then(|(_, summary)| summary.get("cwd"))
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| {
                std::env::current_dir()
                    .ok()
                    .map(|dir| dir.to_string_lossy().to_string())
            })
            .unwrap_or_else(|| "/".to_string());
        let sessions_dir = match source {
            Some((resident, _)) => {
                let descriptor = resident.descriptor.lock().await;
                descriptor
                    .session_dir
                    .clone()
                    .map(|dir| crate::paths::expand_tilde(&dir))
            }
            None => None,
        };
        let sessions_dir = match sessions_dir {
            Some(result) => match result {
                Ok(dir) => dir,
                Err(error) => return WakeOutcome::Failed(error.to_string()),
            },
            None => match crate::paths::sessions_dir(&self.options.agent_dir) {
                Ok(dir) => dir,
                Err(error) => return WakeOutcome::Failed(error.to_string()),
            },
        };
        let archive_dir = crate::session_archive::archive_dir(&self.options.agent_dir);
        let info = match crate::session_catalog::resolve_saved_session(
            &sessions_dir,
            &archive_dir,
            selector,
            &cwd,
        ) {
            Ok(Some(info)) => info,
            // The saved-session catalog misses RLM children: they
            // persist in the parent's session-artifacts tree, not the
            // sessions dir. The spawn ledger still tracks them, so a
            // child selector falls back to its live edges (child id,
            // session id, or name) and wakes the child's own file.
            Ok(None) => {
                return match self.wake_ledger_child(selector, &sessions_dir).await {
                    Some(outcome) => outcome,
                    None => WakeOutcome::Unknown,
                }
            }
            Err(error) => return WakeOutcome::Failed(error.to_string()),
        };
        let session_path = info.path.to_string_lossy().to_string();
        // Reuse before spawning (TS `createOrReuseWorker`): a resident
        // worker already hosting the file serves the wake.
        if let Some(resident) = self.registry.find_by_session_file(&session_path).await {
            return WakeOutcome::Woken(resident);
        }
        // The wake create: one worker over the saved file (the headless
        // resume path), carrying the session's own cwd.
        let create = DaemonCommand::Create {
            id: None,
            session_path: Some(session_path),
            continue_recent: Some(false),
            no_session: None,
            name: None,
            config: Some(json!({ "cwd": info.cwd })),
            // Telemetry opt-out only ever rides an explicit user create;
            // the wake create inherits the daemon default (absent).
            telemetry_disabled: None,
            runtime_metadata: None,
            lifecycle: None,
            env: None,
            launch_env: None,
            rest: Default::default(),
        };
        match self.launch_worker(&create, None).await {
            Ok(resident) => {
                self.refresh_roster_entry(&resident).await;
                WakeOutcome::Woken(resident)
            }
            Err(error) => WakeOutcome::Failed(format!("{error:#}")),
        }
    }
}

impl Supervisor {
    /// The deferred ledger fallback for the `send_message` wake: resolve
    /// a selector the saved-session catalog missed against the spawn
    /// ledger's live child edges (the child id, the child's session-id
    /// file stem, or the child's name), then wake one worker over the
    /// child's session file. `None` keeps the caller's unknown-session
    /// error; `Some(Failed)` carries the wake's own error (an ambiguous
    /// selector outranks the miss, like the catalog's).
    async fn wake_ledger_child(
        self: &Arc<Self>,
        selector: &str,
        sessions_dir: &std::path::Path,
    ) -> Option<WakeOutcome> {
        let ledger = match self
            .rlm_spawn_ledger_for(Some(&sessions_dir.to_string_lossy()))
            .await
        {
            Ok(ledger) => ledger,
            Err(error) => return Some(WakeOutcome::Failed(error.to_string())),
        };
        let edges = match ledger.live_edges() {
            Ok(edges) => edges,
            Err(error) => return Some(WakeOutcome::Failed(error.to_string())),
        };
        let mut matches: Vec<&crate::rlm_ledger::RlmLedgerEdge> = edges
            .iter()
            .filter(|edge| ledger_edge_matches(edge, selector))
            .collect();
        match matches.len() {
            0 => None,
            1 => {
                let edge = matches.pop().expect("one match");
                let session_file = edge.child.clone();
                let cwd =
                    crate::session_store::read_session_info(std::path::Path::new(&session_file))
                        .map(|info| info.cwd)
                        .unwrap_or_else(|| "/".to_string());
                Some(self.launch_ledger_child_wake(&session_file, cwd).await)
            }
            _ => Some(WakeOutcome::Failed(format!(
                "Ambiguous session selector \"{selector}\""
            ))),
        }
    }

    /// Spawn one worker over a ledger child's session file (the same
    /// create the saved-session wake uses).
    async fn launch_ledger_child_wake(
        self: &Arc<Self>,
        session_file: &str,
        cwd: String,
    ) -> WakeOutcome {
        let create = DaemonCommand::Create {
            id: None,
            session_path: Some(session_file.to_string()),
            continue_recent: Some(false),
            no_session: None,
            name: None,
            config: Some(json!({ "cwd": cwd })),
            telemetry_disabled: None,
            runtime_metadata: None,
            lifecycle: None,
            env: None,
            launch_env: None,
            rest: Default::default(),
        };
        match self.launch_worker(&create, None).await {
            Ok(resident) => {
                self.refresh_roster_entry(&resident).await;
                WakeOutcome::Woken(resident)
            }
            Err(error) => WakeOutcome::Failed(format!("{error:#}")),
        }
    }
}

/// Whether a ledger child edge answers a wake selector: by its recorded
/// name, its RLM child id, or its persisted session id (the session-file
/// stem).
fn ledger_edge_matches(edge: &crate::rlm_ledger::RlmLedgerEdge, selector: &str) -> bool {
    edge.name == selector
        || edge.child_id == selector
        || std::path::Path::new(&edge.child)
            .file_stem()
            .is_some_and(|stem| stem == selector)
}

/// Sender endpoint for an agent-origin message: the source session's live
/// summary (the TS supervisor reads the same fields from its roster
/// entry).
fn sender_endpoint_from_summary(summary: &Value, client_id: &str) -> Value {
    let mut sender = json!({
        "activeSessionId": summary
            .get("activeSessionId")
            .or_else(|| summary.get("id"))
            .cloned()
            .unwrap_or(Value::Null),
        "sessionId": summary.get("sessionId").cloned().unwrap_or(Value::Null),
        "runtimeKind": summary
            .get("runtimeKind")
            .cloned()
            .unwrap_or(json!("top-level")),
        "clientId": client_id,
    });
    if let Some(name) = summary.get("sessionName").and_then(Value::as_str) {
        if !name.is_empty() {
            sender["sessionName"] = json!(name);
        }
    }
    sender
}

/// The wake outcome for an unknown `send_message` target.
enum WakeOutcome {
    /// The saved session was woken (or reused); the resident serves it.
    Woken(Arc<ResidentWorker>),
    /// No saved session matched: the caller answers with the TS
    /// unknown-session error.
    Unknown,
    /// The wake itself failed; the error is final.
    Failed(String),
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::registry::ResidentWorker;
    use crate::supervisor::SupervisorOptions;
    use pa_types::daemon::{
        DaemonWorkerDescriptor, DaemonWorkerLifecycle, DurableDaemonCreateCommand,
    };

    fn resident(worker_id: &str) -> Arc<ResidentWorker> {
        ResidentWorker::new(
            worker_id.to_string(),
            DaemonWorkerDescriptor {
                version: 2,
                worker_id: worker_id.to_string(),
                pid: 1,
                process_start_id: None,
                socket_path: "/w.sock".to_string(),
                recovery_journal_path: "/w.jsonl".to_string(),
                orphan_process_journal_path: None,
                supervisor_socket_path: "/s.sock".to_string(),
                authentication_token: "t".to_string(),
                worker_instance_id: None,
                root_active_session_id: worker_id.to_string(),
                owner_client_id: None,
                root_session_id: None,
                session_file: Some("/sessions/some-session.jsonl".to_string()),
                session_dir: None,
                telemetry_disabled: None,
                created_at: "t".to_string(),
                updated_at: "t".to_string(),
                lifecycle: DaemonWorkerLifecycle::Ready,
                create_command: DurableDaemonCreateCommand {
                    session_path: None,
                    no_session: None,
                    rest: Default::default(),
                },
                consecutive_failures: 0,
                stop_requested_at: None,
                archive_on_stop: None,
                last_failure_at: None,
                last_error: None,
                rest: Default::default(),
            },
            std::path::PathBuf::from("/d.json"),
        )
    }

    fn supervisor() -> Arc<Supervisor> {
        let dir = tempfile::TempDir::new().unwrap();
        Arc::new(
            Supervisor::new(SupervisorOptions {
                socket_path: dir.path().join("s.sock"),
                agent_dir: dir.path().join("agent"),
            })
            .unwrap(),
        )
    }

    fn send_command(target: &str, from: Option<&str>) -> DaemonCommand {
        DaemonCommand::SendMessage {
            id: Some("m1".to_string()),
            target_active_session_id: target.to_string(),
            message: "hello".to_string(),
            from_active_session_id: from.map(str::to_string),
            agent_origin: None,
            delivery_mode: None,
            rest: Default::default(),
        }
    }

    /// An unknown target answers with the TS unknown-session error, with
    /// the request id and command echoed on the failure response.
    #[tokio::test]
    async fn unknown_target_answers_with_the_ts_error() {
        let supervisor = supervisor();
        let response = supervisor
            .handle_send_message("m1", "cli-1", &send_command("no-such-session", None))
            .await;
        assert!(!response.success, "{response:?}");
        assert_eq!(response.id.as_deref(), Some("m1"));
        assert_eq!(response.command, "send_message");
        assert_eq!(
            response.error.as_deref(),
            Some("Unknown active session: no-such-session")
        );
    }

    /// The source resolves before the target, so an unknown source fails
    /// even when the target is resident.
    #[tokio::test]
    async fn unknown_source_fails_like_the_ts_source_lookup() {
        let supervisor = supervisor();
        supervisor.registry.insert(resident("target-1")).await;
        let response = supervisor
            .handle_send_message("m1", "cli-1", &send_command("target-1", Some("ghost")))
            .await;
        assert!(!response.success, "{response:?}");
        assert_eq!(
            response.error.as_deref(),
            Some("Unknown active session: ghost")
        );
    }

    /// A session cannot message itself (TS self-target guard).
    #[tokio::test]
    async fn self_target_is_refused() {
        let supervisor = supervisor();
        supervisor.registry.insert(resident("solo-1")).await;
        let response = supervisor
            .handle_send_message("m1", "cli-1", &send_command("solo-1", Some("solo-1")))
            .await;
        assert!(!response.success, "{response:?}");
        assert_eq!(
            response.error.as_deref(),
            Some("Agent messaging cannot target the sending session")
        );
    }

    /// A selector that names two saved sessions is ambiguous, and the
    /// catalog's ambiguity error outranks the unknown-active-session miss
    /// (TS preserves it for a2a senders).
    #[tokio::test]
    async fn ambiguous_saved_selector_carries_the_catalog_error() {
        let supervisor = supervisor();
        let sessions = crate::paths::sessions_dir(&supervisor.options.agent_dir).unwrap();
        std::fs::create_dir_all(&sessions).unwrap();
        for _ in 0..2 {
            let mut session = crate::session_store::SessionFile::create("/tmp", None, 0);
            session.append_session_info("twin");
            session.set_path(sessions.join(format!("{}.jsonl", session.session_id())));
            session.rewrite().unwrap();
        }
        let response = supervisor
            .handle_send_message("m1", "cli-1", &send_command("twin", None))
            .await;
        assert!(!response.success, "{response:?}");
        assert_eq!(
            response.error.as_deref(),
            Some("Ambiguous session selector \"twin\"")
        );
    }

    /// The ledger fallback selector: a child edge answers by name, by its
    /// RLM child id, and by its persisted session id (the file stem), never
    /// by a partial id.
    #[test]
    fn ledger_edges_match_by_name_child_id_and_session_id() {
        let edge = crate::rlm_ledger::RlmLedgerEdge {
            child_id: "sub-kid1".to_string(),
            parent: "/sessions/parent.jsonl".to_string(),
            child: "/artifacts/parent/sub-kid1/sess-kid.jsonl".to_string(),
            depth: 1,
            name: "kid".to_string(),
            deleted: None,
        };
        for selector in ["kid", "sub-kid1", "sess-kid"] {
            assert!(ledger_edge_matches(&edge, selector), "{selector}");
        }
        assert!(!ledger_edge_matches(&edge, "ki"));
        assert!(!ledger_edge_matches(&edge, "parent.jsonl"));
    }

    /// Delivery routes `worker_deliver_message` to the resolved target with
    /// a CLI-origin sender; the resident has no live worker connection, so
    /// the route fails with the not-connected error (the arm reached the
    /// routing stage with the right command).
    #[tokio::test]
    async fn delivery_routes_worker_deliver_message_to_the_target() {
        let supervisor = supervisor();
        supervisor.registry.insert(resident("target-1")).await;
        let response = supervisor
            .handle_send_message("m1", "cli-1", &send_command("target-1", None))
            .await;
        assert!(!response.success, "{response:?}");
        assert_eq!(
            response.error.as_deref(),
            Some("Session worker is not connected")
        );
    }
}
