//! Boot sweep + roster restore + the dormant scheduled-jobs report (spec §6):
//! the durable truth rehydrates from recovery journals and session files.
//!
//! THE NO-AUTO-RESUME CONTRACT: a boot never creates a worker the user did
//! not ask for; due heartbeats stay dormant (restore never fails the boot).

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Mutex;

use anyhow::{Context, Result};
use pa_types::daemon::update_flow::DaemonUpdateResume;
use pa_types::daemon::update_flow::{
    legacy_update_restart_status, legacy_update_restarts_dir, socket_update_dir, UpdateRoster,
    UpdateRosterSession, UpdateStatusCounts, UpdateStatusFailure, UPDATE_ROSTER_ENV,
};
use pa_types::daemon::{DaemonCommand, UpdateId};
use serde_json::json;
use tokio::sync::Notify;

use crate::backpressure::RouteAdmission;
use crate::registry::ResidentWorker;
use crate::supervisor::Supervisor;

/// The client id the supervisor uses for roster-row creates.
pub(crate) const UPDATE_RESTORE_CLIENT_ID: &str = "update-restore";

/// TS `UPDATE_RESTART_CONTINUATION_PROMPT`, verbatim (spec §10.5).
pub(crate) const UPDATE_RESTART_CONTINUATION_PROMPT: &str = "Prime Agent restarted after an update. Continue the interrupted task from the saved transcript and restored tool/kernel state. Inspect current state before retrying commands when needed.";

/// How long a client attach queues behind an in-flight restore pass (spec §10.4).
const RESTORE_ATTACH_WAIT_MS: u64 = 120_000;

// Shared restore state (hello contract, status RPC, queued attaches)

/// One roster row's settle outcome, for attach queuing (spec §10.4).
#[derive(Debug, Clone)]
struct RestoreTarget {
    active_session_id: String,
    session_file: String,
    /// The row's session name: `SessionRegistry::resolve` accepts name selectors.
    name: Option<String>,
    /// The row needs the TS-parity continuation treatment (§10.5): an
    /// early settle must not wake its waiters ahead of the prompt.
    needs_continuation: bool,
    /// Set the moment the pass finishes this row (or adoption brings the worker up).
    settled: bool,
    failure: Option<String>,
}

/// The supervisor's restore pass state (hello contract, `update_restore_status` RPC, attach queue):
/// a brief `std` mutex, no awaits inside; waiters park on the notify.
#[derive(Debug, Default)]
pub(crate) struct RestoreProgress {
    update_id: Mutex<Option<UpdateId>>,
    state: Mutex<RestoreInner>,
    notify: Notify,
}

#[derive(Debug, Default)]
struct RestoreInner {
    done: bool,
    /// Bumped on every row settle: the per-row waiters' budget re-arms
    /// while the pass keeps making progress.
    settled_generation: u64,
    targets: BTreeMap<String, RestoreTarget>,
    counts: UpdateStatusCounts,
    failures: Vec<UpdateStatusFailure>,
}

impl RestoreProgress {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    /// Record the boot's update identity before serving, and register
    /// the roster rows: a mid-recovery reconnect queues behind its row (spec §10.4).
    pub(crate) fn begin(&self, roster: Option<&UpdateRoster>) {
        *self.update_id.lock().unwrap() = roster.map(|roster| roster.update_id.clone());
        if let Some(roster) = roster {
            self.register_targets(roster);
        }
    }

    pub(crate) fn update_id(&self) -> Option<UpdateId> {
        self.update_id.lock().unwrap().clone()
    }

    /// The hello resume contract (spec §10.3).
    pub(crate) fn hello_resume(&self) -> DaemonUpdateResume {
        let state = self.state.lock().unwrap();
        DaemonUpdateResume {
            update_id: self.update_id(),
            complete: state.done,
        }
    }

    /// Register the roster rows the restore pass will settle.
    fn register_targets(&self, roster: &UpdateRoster) {
        let mut state = self.state.lock().unwrap();
        for row in &roster.sessions {
            state.targets.insert(
                row.session_id.clone(),
                RestoreTarget {
                    active_session_id: row.active_session_id.clone(),
                    session_file: row.session_file.clone(),
                    name: row.name.clone(),
                    needs_continuation: roster
                        .rest
                        .get("legacy_ts_restart")
                        .and_then(serde_json::Value::as_bool)
                        == Some(true)
                        || (row.should_resume && row.in_flight.streaming),
                    settled: false,
                    failure: None,
                },
            );
        }
    }

    /// Record one row's settle outcome the moment the recovery finishes
    /// it: the row's waiters wake immediately. Idempotent.
    pub(crate) fn settle_target(&self, selector: &str, failure: Option<String>) {
        {
            let mut state = self.state.lock().unwrap();
            let Some(target) = restore_target_mut(&mut state.targets, selector) else {
                return;
            };
            if target.settled {
                return;
            }
            target.settled = true;
            target.failure = failure;
            state.settled_generation += 1;
        }
        self.notify.notify_waiters();
    }

    /// Settle a row an adoption or live (re-)registration brought up, not
    /// the pass itself; a row pending its continuation treatment (§10.5)
    /// stays queued — the skip still bumps the generation.
    pub(crate) fn settle_adopted(&self, selector: &str) {
        {
            let mut state = self.state.lock().unwrap();
            let Some(target) = restore_target_mut(&mut state.targets, selector) else {
                return;
            };
            if target.settled {
                return;
            }
            if target.needs_continuation {
                state.settled_generation += 1;
            } else {
                target.settled = true;
                state.settled_generation += 1;
            }
        }
        self.notify.notify_waiters();
    }

    /// Mark the pass settled: per-row outcomes, counts, and the waiters' wakeup. Idempotent.
    fn settle(&self, counts: UpdateStatusCounts, failures: Vec<UpdateStatusFailure>) {
        {
            let mut state = self.state.lock().unwrap();
            if state.done {
                return;
            }
            state.done = true;
            state.counts = counts;
            let mut by_file: BTreeMap<&str, &str> = BTreeMap::new();
            for failure in &failures {
                by_file.insert(failure.session_file.as_str(), failure.message.as_str());
            }
            for target in state.targets.values_mut() {
                target.settled = true;
                target.failure = by_file
                    .get(target.session_file.as_str())
                    .map(std::string::ToString::to_string);
            }
            state.settled_generation += 1;
            state.failures = failures;
        }
        self.notify.notify_waiters();
    }

    /// One row's failure message once settled, if any (spec §10.4).
    fn settled_failure(&self, selector: &str) -> Option<(String, String)> {
        let state = self.state.lock().unwrap();
        let target = restore_target(&state.targets, selector)?;
        target
            .failure
            .as_ref()
            .map(|message| (target.session_file.clone(), message.clone()))
    }

    /// Whether an in-flight pass owns the selector: any roster row the
    /// registry-shaped selector resolves to.
    fn owns_target(&self, selector: &str) -> bool {
        let state = self.state.lock().unwrap();
        !state.done && restore_target(&state.targets, selector).is_some()
    }

    /// Wait for one target's settle outcome, not the whole pass (spec
    /// §10.4). The deadline bounds the queue's quiet time: every settle
    /// progress re-arms it, so a wedged pass cannot hold a client.
    async fn wait_for_settle_target(&self, selector: &str) {
        let quiet = std::time::Duration::from_millis(RESTORE_ATTACH_WAIT_MS.max(1));
        let (mut last_generation, mut deadline) = {
            let state = self.state.lock().unwrap();
            (
                state.settled_generation,
                tokio::time::Instant::now() + quiet,
            )
        };
        loop {
            // Register interest before re-checking: a settle that runs
            // between the check and the registration must still wake us.
            let notified = self.notify.notified();
            let (settled, generation) = {
                let state = self.state.lock().unwrap();
                (
                    state.done
                        || restore_target(&state.targets, selector)
                            .is_none_or(|target| target.settled),
                    state.settled_generation,
                )
            };
            if settled {
                return;
            }
            if generation != last_generation {
                last_generation = generation;
                deadline = tokio::time::Instant::now() + quiet;
            }
            if tokio::time::Instant::now() >= deadline {
                return;
            }
            tokio::select! {
                () = notified => {}
                () = tokio::time::sleep_until(deadline) => {}
            }
        }
    }
}

/// Whether one target answers the registry-shaped selector (the durable
/// id is the map key, checked first) — the same shapes `SessionRegistry::resolve` accepts.
fn matches_selector(target: &RestoreTarget, selector: &str) -> bool {
    if target.active_session_id == selector {
        return true;
    }
    let stem = Path::new(&target.session_file)
        .file_stem()
        .map(|stem| stem.to_string_lossy().to_string())
        .unwrap_or_default();
    if crate::registry::selector_matches(&target.active_session_id, selector)
        || (!stem.is_empty() && crate::registry::selector_matches(&stem, selector))
    {
        return true;
    }
    target
        .name
        .as_deref()
        .is_some_and(|name| !name.is_empty() && name == selector)
}

/// The map key a selector addresses: the exact durable id, or the key
/// of the single row the selector matches (ambiguous matches nothing).
fn restore_target_key(targets: &BTreeMap<String, RestoreTarget>, selector: &str) -> Option<String> {
    if targets.contains_key(selector) {
        return Some(selector.to_string());
    }
    let mut matches = targets
        .iter()
        .filter(|(_, target)| matches_selector(target, selector));
    let (key, _) = matches.next()?;
    matches.next().is_none().then(|| key.clone())
}

/// The roster row a selector addresses: any selector shape the registry
/// accepts, resolved to exactly one row.
fn restore_target<'a>(
    targets: &'a BTreeMap<String, RestoreTarget>,
    selector: &str,
) -> Option<&'a RestoreTarget> {
    restore_target_key(targets, selector).and_then(|key| targets.get(&key))
}

/// The mutable counterpart of [`restore_target`].
fn restore_target_mut<'a>(
    targets: &'a mut BTreeMap<String, RestoreTarget>,
    selector: &str,
) -> Option<&'a mut RestoreTarget> {
    restore_target_key(targets, selector).and_then(|key| targets.get_mut(&key))
}

// Spec §6 step 1: the boot sweep

/// Delete this socket's scratch directory and stale legacy names after consuming
/// the roster env. Keep a TS manifest while its socket-bound prepare attempt is
/// pending: an ordinary boot after a lost reply must not destroy recovery input.
/// Flat TS status records remain available to callers waiting for their result.
pub(crate) fn boot_sweep(agent_dir: &Path, socket_path: &Path) {
    let socket_hash = crate::paths::hash_key(&socket_path.to_string_lossy(), 64);
    let _ = std::fs::remove_dir_all(socket_update_dir(agent_dir, &socket_hash));
    let legacy_dir = legacy_update_restarts_dir(agent_dir);
    if legacy_dir.is_symlink() {
        // Never walk a symlink while deleting scratch entries.
        let _ = std::fs::remove_file(&legacy_dir);
    } else if let Ok(entries) = std::fs::read_dir(&legacy_dir) {
        for entry in entries {
            let entry = match entry {
                Ok(entry) => entry,
                Err(error) => {
                    eprintln!("pa-daemon: could not inspect legacy update scratch: {error}");
                    continue;
                }
            };
            let path = entry.path();
            let pending = path
                .file_stem()
                .and_then(|stem| stem.to_str())
                .is_some_and(|key| {
                    if path.extension().and_then(|extension| extension.to_str()) != Some("json") {
                        return false;
                    }
                    let attempt_path = agent_dir
                        .join("legacy-update-recovery")
                        .join(format!("{key}.attempt.json"));
                    let attempt = std::fs::read(attempt_path)
                        .ok()
                        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok());
                    let Some(attempt) = attempt else {
                        return false;
                    };
                    let Some(socket) = attempt["socket"]
                        .as_str()
                        .filter(|socket| !socket.is_empty())
                    else {
                        return false;
                    };
                    // Retain attempts for every socket, including older target versions.
                    // The CLI owns full predecessor/freshness validation and removes the
                    // attempt only after confirmed restoration or a safe prepare refusal.
                    crate::paths::hash_key(socket, 64) == key
                        && attempt["version"]
                            .as_str()
                            .is_some_and(|version| !version.is_empty())
                        && attempt["updateId"]
                            .as_str()
                            .is_some_and(|id| !id.is_empty())
                        && attempt["startedAt"].as_u64().is_some()
                        && attempt["hello"]["supervisorPid"]
                            .as_u64()
                            .is_some_and(|pid| pid > 0)
                        && attempt["hello"]["supervisorProcessStartId"]
                            .as_str()
                            .is_some_and(|id| !id.is_empty())
                        && attempt["hello"]["supervisorGeneration"]
                            .as_str()
                            .is_some_and(|generation| !generation.is_empty())
                });
            if !pending {
                if path.is_dir() {
                    let _ = std::fs::remove_dir_all(path);
                } else {
                    let _ = std::fs::remove_file(path);
                }
            }
        }
        // Only remove an empty directory; pending sources keep their original paths.
        let _ = std::fs::remove_dir(&legacy_dir);
    }
    let _ = std::fs::remove_file(legacy_update_restart_status(agent_dir));
}

// Spec §6 step 2: consume the roster from the spawn env

/// Read `PRIME_AGENT_UPDATE_ROSTER`: a coordinator-passed path, never
/// discovered. `None` on a normal boot; a malformed roster never fails the boot (spec §9).
pub(crate) fn consume_roster_env() -> Option<UpdateRoster> {
    let path = std::env::var(UPDATE_ROSTER_ENV).ok()?;
    let path = Path::new(&path);
    let content = match std::fs::read_to_string(path) {
        Ok(content) => content,
        Err(error) => {
            eprintln!(
                "pa-daemon: could not read the update roster at {}: {error}",
                path.display()
            );
            return None;
        }
    };
    match serde_json::from_str(&content) {
        Ok(roster) => Some(roster),
        Err(error) => {
            eprintln!(
                "pa-daemon: malformed update roster at {}: {error}",
                path.display()
            );
            None
        }
    }
}

// Spec §6 steps 2-3: the restore pass + the re-arm

/// Order roster rows bottom-up (spec §8): deepest first so parents attach to existing children;
/// subagents before top-level rows of equal depth; stable by session id otherwise.
fn sort_rows_bottom_up(rows: &mut [&UpdateRosterSession]) {
    rows.sort_by(|a, b| {
        b.rlm_depth.cmp(&a.rlm_depth).then_with(|| {
            let subagent = |row: &UpdateRosterSession| {
                row.kind == pa_types::daemon::update_flow::UpdateRosterSessionKind::Subagent
            };
            u8::from(subagent(b)).cmp(&u8::from(subagent(a)))
        })
    });
}

/// The boot restore driver: run after the descriptor-adoption task
/// settles, then walk Rust rows bottom-up (spec §8), or TS rows parent-first
/// so their fresh active handles can be remapped. NOT-RUNNING
/// sessions stay down; the dormant report runs AFTER the replay.
pub(crate) async fn restore_pass(
    supervisor: &std::sync::Arc<Supervisor>,
    adoption: tokio::task::JoinHandle<()>,
    roster: Option<UpdateRoster>,
) {
    let _ = adoption.await;
    let Some(roster) = roster else {
        report_dormant_scheduled_jobs(supervisor).await;
        supervisor
            .restore
            .settle(UpdateStatusCounts::default(), Vec::new());
        return;
    };
    let mut rows: Vec<&UpdateRosterSession> = roster.sessions.iter().collect();
    let legacy = roster
        .rest
        .get("legacy_ts_restart")
        .and_then(serde_json::Value::as_bool)
        == Some(true);
    if legacy {
        rows.sort_by_key(|row| row.rlm_depth);
    } else {
        sort_rows_bottom_up(&mut rows);
    }
    let mut restored_ids = BTreeMap::new();
    let mut counts = UpdateStatusCounts::default();
    let mut failures: Vec<UpdateStatusFailure> = Vec::new();
    for row in rows {
        counts.total += 1;
        let restored = match supervisor
            .registry
            .find_by_session_file(&row.session_file)
            .await
        {
            Some(resident) => Ok(resident),
            None => restore_session(supervisor, row, legacy.then_some(&restored_ids)).await,
        };
        let restored = match restored {
            Ok(resident) if legacy => {
                restored_ids.insert(
                    row.active_session_id.clone(),
                    resident
                        .descriptor
                        .lock()
                        .await
                        .root_active_session_id
                        .clone(),
                );
                let origin = roster
                    .rest
                    .get("restart_origin_active_session_id")
                    .and_then(serde_json::Value::as_str);
                match restore_legacy_session(
                    row,
                    origin,
                    &roster.binary.to_version,
                    |command, payload| {
                        supervisor.route_command_typed(
                            &resident,
                            command,
                            payload,
                            crate::supervisor::ROUTE_TIMEOUT_MS,
                            RouteAdmission::SupervisorInternal,
                        )
                    },
                )
                .await
                {
                    Ok(resumed) => {
                        counts.resumed += u64::from(resumed);
                        Ok(resident)
                    }
                    Err(error) => Err(error),
                }
            }
            Ok(resident) => {
                supervisor.restore.settle_target(&row.session_id, None);
                continuation_treatment(supervisor, &resident, row, &mut counts).await;
                Ok(resident)
            }
            Err(error) => Err(error),
        };
        match restored {
            Ok(_) => {
                counts.restored += 1;
                supervisor.restore.settle_target(&row.session_id, None);
            }
            Err(error) => {
                let message = format!("{error:#}");
                supervisor.log_line(&format!(
                    "update restore: could not restore {}: {message}",
                    row.session_file
                ));
                supervisor
                    .restore
                    .settle_target(&row.session_id, Some(message.clone()));
                failures.push(UpdateStatusFailure {
                    session_file: row.session_file.clone(),
                    message,
                });
                counts.failed += 1;
            }
        }
    }
    // The dormant report runs here, AFTER the replay: only the sessions that stayed down count.
    report_dormant_scheduled_jobs(supervisor).await;
    supervisor.restore.settle(counts, failures);
}

/// Replay the TS manifest, whose queues have no Rust recovery journal. The
/// command boundary is injectable so regression tests exercise the same ordering
/// and acknowledgement handling as the live supervisor route.
async fn restore_legacy_session<F, Fut>(
    row: &UpdateRosterSession,
    origin: Option<&str>,
    version: &str,
    mut route: F,
) -> Result<bool>
where
    F: FnMut(&'static str, serde_json::Value) -> Fut,
    Fut: std::future::Future<Output = Result<crate::protocol::DaemonResponse>>,
{
    let actions = row
        .queue
        .actions
        .get("actions")
        .and_then(serde_json::Value::as_array);
    let has_actions = actions.is_some_and(|actions| !actions.is_empty());
    // restore_actions wakes Rust's runner immediately. Hold its existing input
    // pause across queue replay and continuation admission, including unrelated
    // wakeups, so a follow-up cannot overtake the interrupted turn.
    let pause = if row.should_resume && has_actions {
        let response = route(
            "acquire_session_input_pause",
            json!({
                "leaseKey": "legacy-update-restore", "clientId": UPDATE_RESTORE_CLIENT_ID,
            }),
        )
        .await?;
        anyhow::ensure!(
            response.success,
            "legacy update acquire_session_input_pause: {}",
            response.error.unwrap_or_default()
        );
        Some(
            response
                .data
                .as_ref()
                .and_then(|data| data.get("pauseId"))
                .and_then(serde_json::Value::as_str)
                .context("legacy update input pause returned no pause id")?
                .to_string(),
        )
    } else {
        None
    };
    let outcome: Result<bool> = async {
        let mut commands = Vec::new();
        if origin == Some(row.active_session_id.as_str()) {
            commands.push(("append_custom_message", json!({ "message": {
                "customType": "prime-agent.update_complete",
                "content": format!("[update-complete]\n\nPrime Agent updated to v{version}. This daemon session was restored after the update."),
                "display": true,
                "details": { "version": version },
            }})));
        }
        if !row.queue.next_turn.is_empty() {
            commands.push((
                "restore_next_turn",
                json!({ "messages": row.queue.next_turn }),
            ));
        }
        if row.should_resume && has_actions {
            commands.push(("restore_actions", json!({ "snapshot": row.queue.actions })));
        }
        for (command, payload) in commands {
            let response = route(command, payload)
                .await
                .with_context(|| format!("legacy update {command}"))?;
            anyhow::ensure!(
                response.success,
                "legacy update {command}: {}",
                response.error.unwrap_or_default()
            );
        }
        if !row.should_resume {
            return Ok(false);
        }
        let accepted_turn = actions.is_some_and(|actions| {
            actions.iter().any(|action| {
                let payload = &action["payload"];
                payload["kind"] == "turn"
                    && payload["queueVisible"] == false
                    && payload["acceptedBeforeCompletion"] == true
            })
        });
        let in_flight = row.in_flight;
        let interrupted = in_flight.streaming
            || in_flight.compacting
            || in_flight.bash_running
            || in_flight.rlm_children
            || in_flight.retrying
            || in_flight.prompt_in_flight;
        let mut resumed = false;
        if interrupted && !accepted_turn {
            let response = route(
                "prompt",
                json!({
                    "message": UPDATE_RESTART_CONTINUATION_PROMPT, "expandPromptTemplates": false,
                }),
            )
            .await?;
            resumed = response.success;
            if !resumed {
                anyhow::bail!(
                    "legacy update continuation: {}",
                    response.error.unwrap_or_default()
                );
            }
        }
        Ok(resumed || has_actions)
    }
    .await;
    if let Some(pause_id) = pause {
        // A partial restore remains parked on failure, but release the temporary
        // lease so the ordinary user resume action can recover the session.
        if outcome.is_err() {
            let response = route("abort", json!({})).await?;
            anyhow::ensure!(
                response.success,
                "legacy update abort after failed restore: {}",
                response.error.unwrap_or_default()
            );
        }
        let response = route(
            "release_session_input_pause",
            json!({
                "pauseId": pause_id, "clientId": UPDATE_RESTORE_CLIENT_ID,
            }),
        )
        .await?;
        anyhow::ensure!(
            response.success,
            "legacy update release_session_input_pause: {}",
            response.error.unwrap_or_default()
        );
    }
    outcome
}

/// Re-create one roster row's session from the durable create command the roster captured (spec §8
/// `runtime_config`): the supervisor's own create path, under the restore client id.
async fn restore_session(
    supervisor: &std::sync::Arc<Supervisor>,
    row: &UpdateRosterSession,
    restored_ids: Option<&BTreeMap<String, String>>,
) -> Result<std::sync::Arc<ResidentWorker>> {
    let durable = row
        .runtime_config
        .get("create")
        .cloned()
        .context("the roster row carries no create command")?;
    let durable: pa_types::daemon::DurableDaemonCreateCommand =
        serde_json::from_value(durable).context("parse the roster row's create command")?;
    let mut payload = crate::descriptor::create_command_payload(&durable);
    if let Some(restored_ids) = restored_ids {
        remap_legacy_parent(&mut payload, restored_ids);
    }
    let command: DaemonCommand =
        serde_json::from_value(payload).context("rebuild the create command")?;
    let summary = supervisor
        .handle_create(&command, UPDATE_RESTORE_CLIENT_ID.to_string())
        .await?;
    let session_id = summary.get("sessionId").and_then(|value| value.as_str());
    if session_id.is_none() {
        anyhow::bail!("the create reply carries no session id");
    }
    supervisor
        .registry
        .find_by_session_file(&row.session_file)
        .await
        .context("the restored session did not register")
}

/// TS restores parent sessions first and substitutes their new active handles;
/// omit an unavailable parent handle instead of retaining a dead TS handle.
fn remap_legacy_parent(payload: &mut serde_json::Value, restored_ids: &BTreeMap<String, String>) {
    let Some(metadata) = payload
        .get_mut("runtimeMetadata")
        .and_then(serde_json::Value::as_object_mut)
    else {
        return;
    };
    if metadata.get("kind").and_then(serde_json::Value::as_str) != Some("subagent") {
        return;
    }
    let Some(old_parent) = metadata.remove("parentActiveSessionId") else {
        return;
    };
    if let Some(new_parent) = old_parent.as_str().and_then(|id| restored_ids.get(id)) {
        metadata.insert("parentActiveSessionId".into(), json!(new_parent));
    }
}

/// The TS-parity continuation treatment (spec §10.5): a row mid-turn when the snapshot was taken
/// gets the continuation prompt; a failed prompt is a resume failure, not a restore failure.
async fn continuation_treatment(
    supervisor: &std::sync::Arc<Supervisor>,
    resident: &std::sync::Arc<ResidentWorker>,
    row: &UpdateRosterSession,
    counts: &mut UpdateStatusCounts,
) {
    if !row.should_resume {
        return;
    }
    if !row.in_flight.streaming {
        // Queued work: the relaunch/create replay restored the lanes.
        counts.resumed += 1;
        return;
    }
    let response = supervisor
        .route_command_typed(
            resident,
            "prompt",
            json!({ "message": UPDATE_RESTART_CONTINUATION_PROMPT }),
            crate::supervisor::ROUTE_TIMEOUT_MS,
            RouteAdmission::SupervisorInternal,
        )
        .await;
    match response {
        Ok(response) if response.success => counts.resumed += 1,
        Ok(response) => supervisor.log_line(&format!(
            "update restore: could not resume {}: {}",
            row.session_file,
            response.error.unwrap_or_default()
        )),
        Err(error) => supervisor.log_line(&format!(
            "update restore: could not resume {}: {error:#}",
            row.session_file
        )),
    }
}

/// The boot's dormant-scheduled-jobs report (the no-auto-resume contract): report ACTIVE, DUE jobs
/// whose session has no live worker — never wake them.
async fn report_dormant_scheduled_jobs(supervisor: &std::sync::Arc<Supervisor>) {
    let jobs = crate::update_roster::scan_scheduled_jobs(&supervisor.options.agent_dir);
    let now = crate::util::now_ms();
    let live = supervisor.live_session_files().await;
    let dormant: Vec<&pa_core::cron::AgentCronJob> = jobs
        .iter()
        .filter(|job| {
            job.status == pa_core::cron::JobStatus::Active
                && pa_core::cron::is_due_job(job, now)
                && !job.session_file.is_empty()
                && !live.contains(
                    &crate::lease::canonical_session_path(std::path::Path::new(&job.session_file))
                        .to_string_lossy()
                        .to_string(),
                )
        })
        .collect();
    if dormant.is_empty() {
        return;
    }
    // One log line per dormant job keeps the log greppable (job id + session file).
    for job in &dormant {
        supervisor.log_line(&format!(
            "scheduled job {} on {} is due but stays dormant: no session auto-boots on daemon start (resume the session to arm its schedule; the heartbeat catalog surfaces it)",
            job.id, job.session_file
        ));
    }
    supervisor.log_line(&format!(
        "{} due scheduled job(s) stayed dormant on not-running sessions (no auto-resume)",
        dormant.len()
    ));
}

// Supervisor integration helpers

impl Supervisor {
    /// Spec §10.4: queue behind an in-flight restore pass that owns the
    /// selector, then re-resolve or fail typed against the settled outcome.
    pub(crate) async fn await_restore_target(&self, selector: &str) {
        if !self.restore.owns_target(selector) {
            // No pass is in flight, or the selector is not a roster row:
            // an unrelated dead session must fail immediately.
            return;
        }
        // Queue behind this session's own row only (spec §10.4).
        self.restore.wait_for_settle_target(selector).await;
    }

    /// Spec §10.4: the settled per-row failure, as the typed attach
    /// error with the session file path and the manual-resume hint.
    pub(crate) fn restore_failure_for(&self, selector: &str) -> Option<String> {
        self.restore
            .settled_failure(selector)
            .map(|(session_file, message)| {
                format!(
                    "Session {selector} failed to restore: {message}. The session file is at \
                     {session_file} — run `prime-agent attach` to resume it manually."
                )
            })
    }

    /// The `update_restore_status` RPC body (the coordinator's `Restoring` report, spec §9).
    pub(crate) fn restore_status_body(&self) -> serde_json::Value {
        let state = self.restore.state.lock().unwrap();
        json!({
            "updateId": self.restore.update_id().map(|id| id.to_string()),
            "inFlight": !state.done,
            "complete": state.done,
            "counts": {
                "total": state.counts.total,
                "restored": state.counts.restored,
                "resumed": state.counts.resumed,
                "failed": state.counts.failed,
            },
            "failures": state.failures,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pa_types::daemon::update_flow::UpdateStatusCounts;
    use serde_json::Map;

    /// A two-row roster (update `u-1`): row `a-1`, and row `durable-b`
    /// whose session-file stem (`b-2`) differs from its durable id.
    fn two_row_roster() -> UpdateRoster {
        serde_json::from_value(serde_json::json!({
            "format_version": 1,
            "update_id": "u-1",
            "socket_path": "/tmp/s.sock",
            "created_at": "2026-01-01T00:00:00Z",
            "supervisor": { "pid": 1, "process_start_id": "p", "generation": "g" },
            "binary": { "from_version": "0.1", "to_version": "0.2" },
            "sessions": [
                {
                    "session_id": "a-1",
                    "active_session_id": "active-a",
                    "session_file": "/sessions/a-1.jsonl",
                    "name": "alpha",
                    "kind": "top-level",
                    "rlm_depth": 0,
                    "cwd": "/w",
                    "runtime_config": {},
                    "queue": { "next_turn": [], "actions": {} },
                    "in_flight": {
                        "streaming": false, "compacting": false, "bash_running": false,
                        "rlm_children": false, "retrying": false, "prompt_in_flight": false
                    },
                    "should_resume": false
                },
                {
                    "session_id": "durable-b",
                    "active_session_id": "active-b",
                    "session_file": "/sessions/b-2.jsonl",
                    "kind": "top-level",
                    "rlm_depth": 0,
                    "cwd": "/w",
                    "runtime_config": {},
                    "queue": { "next_turn": [], "actions": {} },
                    "in_flight": {
                        "streaming": false, "compacting": false, "bash_running": false,
                        "rlm_children": false, "retrying": false, "prompt_in_flight": false
                    },
                    "should_resume": false
                }
            ],
        }))
        .unwrap()
    }

    #[tokio::test]
    async fn legacy_restore_replays_context_and_actions_before_continuing_each_interrupted_kind() {
        for flag in [
            "streaming",
            "compacting",
            "bash_running",
            "rlm_children",
            "retrying",
            "prompt_in_flight",
        ] {
            let mut row = two_row_roster().sessions.remove(0);
            row.should_resume = true;
            let mut in_flight = serde_json::to_value(row.in_flight).unwrap();
            in_flight[flag] = json!(true);
            row.in_flight = serde_json::from_value(in_flight).unwrap();
            row.queue.next_turn = serde_json::from_value(json!([{
                "customType": "saved-context", "content": "keep this", "display": false,
                "timestamp": 1
            }]))
            .unwrap();
            row.queue.actions = json!({ "formatVersion": 1, "actions": [{
                "id": "queued", "payload": { "kind": "turn", "text": "next task", "queueVisible": true }
            }] });
            let mut calls = Vec::new();
            let resumed =
                restore_legacy_session(&row, Some("active-a"), "1.0.0", |command, payload| {
                    calls.push((command, payload));
                    std::future::ready(Ok(crate::protocol::response_success(
                        None,
                        command,
                        Some(json!({ "pauseId": "test-pause" })),
                    )))
                })
                .await
                .unwrap();
            assert!(resumed, "{flag}");
            assert_eq!(
                calls,
                vec![
                    (
                        "acquire_session_input_pause",
                        json!({ "leaseKey": "legacy-update-restore", "clientId": UPDATE_RESTORE_CLIENT_ID })
                    ),
                    (
                        "append_custom_message",
                        json!({ "message": {
                            "customType": "prime-agent.update_complete",
                            "content": "[update-complete]\n\nPrime Agent updated to v1.0.0. This daemon session was restored after the update.",
                            "display": true, "details": { "version": "1.0.0" }
                        }})
                    ),
                    (
                        "restore_next_turn",
                        json!({ "messages": row.queue.next_turn })
                    ),
                    ("restore_actions", json!({ "snapshot": row.queue.actions })),
                    (
                        "prompt",
                        json!({ "message": UPDATE_RESTART_CONTINUATION_PROMPT, "expandPromptTemplates": false })
                    ),
                    (
                        "release_session_input_pause",
                        json!({ "pauseId": "test-pause", "clientId": UPDATE_RESTORE_CLIENT_ID })
                    ),
                ],
                "{flag}"
            );
        }
    }

    #[tokio::test]
    async fn legacy_restore_resumes_an_accepted_turn_without_duplicating_its_prompt() {
        let mut row = two_row_roster().sessions.remove(0);
        row.should_resume = true;
        row.in_flight.prompt_in_flight = true;
        row.queue.actions = json!({ "formatVersion": 1, "actions": [{
            "id": "accepted", "payload": { "kind": "turn", "text": "already admitted",
                "queueVisible": false, "acceptedBeforeCompletion": true }
        }] });
        let mut calls = Vec::new();
        assert!(
            restore_legacy_session(&row, None, "1.0.0", |command, payload| {
                calls.push((command, payload));
                std::future::ready(Ok(crate::protocol::response_success(
                    None,
                    command,
                    Some(json!({ "pauseId": "test-pause" })),
                )))
            })
            .await
            .unwrap()
        );
        assert_eq!(
            calls,
            vec![
                (
                    "acquire_session_input_pause",
                    json!({ "leaseKey": "legacy-update-restore", "clientId": UPDATE_RESTORE_CLIENT_ID })
                ),
                ("restore_actions", json!({ "snapshot": row.queue.actions })),
                (
                    "release_session_input_pause",
                    json!({ "pauseId": "test-pause", "clientId": UPDATE_RESTORE_CLIENT_ID })
                ),
            ]
        );
    }

    #[tokio::test]
    async fn legacy_restore_does_not_resume_idle_sessions_and_reports_failed_queue_restore() {
        let mut row = two_row_roster().sessions.remove(0);
        row.queue.actions = json!({ "formatVersion": 1, "actions": [{"id": "queued"}] });
        let mut calls = Vec::new();
        assert!(!restore_legacy_session(&row, None, "1.0.0", |command, _| {
            calls.push(command);
            std::future::ready(Ok(crate::protocol::response_success(
                None,
                command,
                Some(json!({ "pauseId": "test-pause" })),
            )))
        })
        .await
        .unwrap());
        assert!(calls.is_empty());
        row.should_resume = true;
        let mut failed_calls = Vec::new();
        let error = restore_legacy_session(&row, None, "1.0.0", |command, _| {
            failed_calls.push(command);
            let response = if command == "restore_actions" {
                crate::protocol::response_failure(None, command, "invalid action", None)
            } else {
                crate::protocol::response_success(
                    None,
                    command,
                    Some(json!({ "pauseId": "test-pause" })),
                )
            };
            std::future::ready(Ok(response))
        })
        .await
        .unwrap_err();
        assert_eq!(
            failed_calls,
            [
                "acquire_session_input_pause",
                "restore_actions",
                "abort",
                "release_session_input_pause"
            ]
        );
        assert_eq!(
            error.to_string(),
            "legacy update restore_actions: invalid action"
        );
    }

    #[tokio::test]
    async fn legacy_manifest_restores_real_worker_context_and_both_queue_lanes() {
        let dir = tempfile::TempDir::new().unwrap();
        let worker = crate::worker::Worker::new(
            crate::worker::WorkerConfig {
                socket_path: dir.path().join("worker.sock"),
                supervisor_socket_path: std::path::PathBuf::new(),
                token: "token".into(),
                worker_instance_id: String::new(),
                active_session_id: "active-a".into(),
                agent_dir: dir.path().join("agent"),
                recovery_journal_path: dir.path().join("recovery.jsonl"),
                telemetry_disabled: Some(true),
                script: Some(json!({ "responses": ["ack"] })),
            },
            None,
        );
        assert!(
            worker
                .dispatch("create", &json!({ "noSession": true, "cwd": dir.path() }))
                .await
                .success
        );
        let mut row = two_row_roster().sessions.remove(0);
        row.should_resume = true;
        row.queue.next_turn = serde_json::from_value(json!([{
            "customType": "saved-context", "content": "pending context", "display": false,
            "timestamp": 1
        }]))
        .unwrap();
        row.queue.actions = json!({ "formatVersion": 1, "actions": [
            { "id": "steer", "delivery": "next_turn_boundary", "payload": { "kind": "turn", "text": "steering task" } },
            { "id": "follow", "delivery": "when_run_idle", "payload": { "kind": "turn", "text": "follow-up task" } }
        ] });
        let resumed = restore_legacy_session(&row, None, "1.0.0", |command, payload| {
            let worker = &worker;
            async move { Ok(worker.dispatch(command, &payload).await) }
        })
        .await
        .unwrap();
        assert!(resumed);
        let core = worker.core.lock().unwrap();
        assert_eq!(
            (
                core.pending_next_turn[0]["content"].clone(),
                core.steering
                    .iter()
                    .map(|item| item.message.clone())
                    .collect::<Vec<_>>(),
                core.follow_up
                    .iter()
                    .map(|item| item.message.clone())
                    .collect::<Vec<_>>()
            ),
            (
                json!("pending context"),
                vec!["steering task".to_string()],
                vec!["follow-up task".to_string()]
            )
        );
    }

    #[tokio::test]
    async fn legacy_busy_restore_keeps_follow_up_behind_continuation_with_a_running_worker() {
        let dir = tempfile::TempDir::new().unwrap();
        let worker = crate::worker::Worker::new(
            crate::worker::WorkerConfig {
                socket_path: dir.path().join("worker.sock"),
                supervisor_socket_path: std::path::PathBuf::new(),
                token: "token".into(),
                worker_instance_id: String::new(),
                active_session_id: "active-a".into(),
                agent_dir: dir.path().join("agent"),
                recovery_journal_path: dir.path().join("recovery.jsonl"),
                telemetry_disabled: Some(true),
                script: Some(json!({ "responses": ["ack", "done"] })),
            },
            None,
        );
        assert!(
            worker
                .dispatch("create", &json!({ "noSession": true, "cwd": dir.path() }))
                .await
                .success
        );
        let mut events = worker.events.subscribe();
        let mut row = two_row_roster().sessions.remove(0);
        row.should_resume = true;
        row.in_flight.streaming = true;
        row.queue.actions = json!({ "formatVersion": 1, "actions": [{
            "id": "follow", "delivery": "when_run_idle", "source": "interactive",
            "payload": { "kind": "turn", "text": "queued follow-up", "queueVisible": true }
        }] });
        assert!(
            restore_legacy_session(&row, None, "1.0.0", |command, payload| {
                let worker = &worker;
                async move {
                    // Observe the real runner handling the restore wake before the
                    // coordinator can admit its continuation. No sleeps or retries.
                    let parked = worker.idle_notify.notified();
                    tokio::pin!(parked);
                    parked.as_mut().enable();
                    let response = worker.dispatch(command, &payload).await;
                    if command == "restore_actions" {
                        worker.work_notify.notify_one();
                        tokio::time::timeout(std::time::Duration::from_secs(5), parked)
                            .await
                            .unwrap();
                        let core = worker.core.lock().unwrap();
                        assert_eq!(
                            (core.busy, core.follow_up.len()),
                            (false, 1),
                            "restored follow-up ran before continuation admission"
                        );
                    }
                    Ok(response)
                }
            })
            .await
            .unwrap()
        );
        let delivered = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            let mut delivered = Vec::new();
            while delivered.len() < 2 {
                let frame = events.recv().await.unwrap();
                let frame: serde_json::Value = serde_json::from_slice(&frame.payload).unwrap();
                let event = &frame["event"];
                if event["type"] == "message_end" && event["message"]["role"] == "user" {
                    let content = &event["message"]["content"];
                    let text = content
                        .as_str()
                        .or_else(|| content[0]["text"].as_str())
                        .unwrap();
                    delivered.push(text.to_string());
                }
            }
            delivered
        })
        .await
        .unwrap();
        assert_eq!(
            delivered,
            [UPDATE_RESTART_CONTINUATION_PROMPT, "queued follow-up"]
        );
        worker.core.lock().unwrap().shutdown_requested = true;
        worker.work_notify.notify_one();
    }

    #[test]
    fn legacy_child_metadata_replaces_only_the_old_parent_handle() {
        let mut payload = json!({ "runtimeMetadata": {
            "kind": "subagent", "parentActiveSessionId": "old-parent", "rlmChildId": "child"
        }});
        remap_legacy_parent(
            &mut payload,
            &BTreeMap::from([("old-parent".into(), "new-parent".into())]),
        );
        assert_eq!(
            payload,
            json!({ "runtimeMetadata": {
                "kind": "subagent", "parentActiveSessionId": "new-parent", "rlmChildId": "child"
            }})
        );
        remap_legacy_parent(&mut payload, &BTreeMap::new());
        assert_eq!(
            payload,
            json!({ "runtimeMetadata": { "kind": "subagent", "rlmChildId": "child" }})
        );
    }

    #[test]
    fn hello_resume_reports_progress_before_and_after_settle() {
        let progress = RestoreProgress::new();
        progress.begin(Some(&two_row_roster()));
        assert!(!progress.hello_resume().complete);
        assert_eq!(
            progress.hello_resume().update_id,
            Some(UpdateId::from("u-1".to_string()))
        );
        progress.settle(
            UpdateStatusCounts {
                total: 2,
                restored: 1,
                resumed: 1,
                failed: 1,
            },
            vec![UpdateStatusFailure {
                session_file: "/sessions/b.jsonl".to_string(),
                message: "worker create failed".to_string(),
            }],
        );
        let hello = progress.hello_resume();
        assert!(hello.complete);
        assert_eq!(hello.update_id, Some(UpdateId::from("u-1".to_string())));
        // Idempotent settle: a second settle never overwrites the first.
        progress.settle(UpdateStatusCounts::default(), Vec::new());
        assert!(progress.hello_resume().complete);
    }

    #[tokio::test(start_paused = true)]
    async fn queued_attach_unblocks_when_only_its_target_settles() {
        let progress = std::sync::Arc::new(RestoreProgress::new());
        progress.begin(Some(&two_row_roster()));
        let waiter = |progress: &std::sync::Arc<RestoreProgress>, selector: &str| {
            let progress = std::sync::Arc::clone(progress);
            let selector = selector.to_string();
            tokio::spawn(async move { progress.wait_for_settle_target(&selector).await })
        };
        let mut queued_a = waiter(&progress, "a-1");
        let mut queued_b = waiter(&progress, "durable-b");
        // Neither row settled (the deadline, not this test's ticks, bounds the queue).
        let tick = std::time::Duration::from_millis(1);
        assert!(tokio::time::timeout(tick, &mut queued_a).await.is_err());
        assert!(tokio::time::timeout(tick, &mut queued_b).await.is_err());
        // One row settles by its stem selector `b-2`: only that row's waiter wakes.
        progress.settle_target("b-2", None);
        assert!(tokio::time::timeout(tick, queued_b).await.is_ok());
        assert!(tokio::time::timeout(tick, &mut queued_a).await.is_err());
        progress.settle(UpdateStatusCounts::default(), Vec::new());
        assert!(tokio::time::timeout(tick, queued_a).await.is_ok());
    }

    #[test]
    fn settle_target_failure_answers_the_typed_attach_error_per_row() {
        let progress = RestoreProgress::new();
        progress.begin(Some(&two_row_roster()));
        progress.settle_target("durable-b", Some("worker create failed".to_string()));
        // Every selector shape for the failed row resolves the failure.
        for selector in ["durable-b", "active-b", "b-2"] {
            let (file, message) = progress.settled_failure(selector).unwrap();
            assert_eq!(file, "/sessions/b-2.jsonl");
            assert_eq!(message, "worker create failed");
        }
        assert!(progress.settled_failure("a-1").is_none());
        assert!(progress.settled_failure("unknown-id").is_none());
    }

    #[test]
    fn registry_shaped_selectors_own_their_row_and_ambiguous_ones_own_nothing() {
        let progress = RestoreProgress::new();
        progress.begin(Some(&two_row_roster()));
        // Every selector shape `SessionRegistry::resolve` accepts owns the
        // row; the durable id is exact-key only.
        for selector in ["a-1", "active-a", "alpha", "ve-a", "IVEA", "b-2", "e-b"] {
            assert!(progress.owns_target(selector), "owns {selector}");
        }
        assert!(!progress.owns_target("unknown"));
        assert!(!progress.owns_target(""));

        // An ambiguous selector owns nothing, like the registry.
        let mut roster = two_row_roster();
        roster.sessions[1].active_session_id = "xx-active-a".to_string();
        let ambiguous = RestoreProgress::new();
        ambiguous.begin(Some(&roster));
        assert!(!ambiguous.owns_target("active-a"));
        ambiguous.settle_target("active-a", Some("never lands".to_string()));
        assert!(ambiguous.settled_failure("active-a").is_none());
        ambiguous.settle_target("alpha", None);
        assert!(ambiguous.settled_failure("alpha").is_none());
        assert!(ambiguous.hello_resume().update_id.is_some());
    }

    #[tokio::test(start_paused = true)]
    async fn an_adoption_settle_skips_a_row_pending_its_continuation() {
        let mut roster = two_row_roster();
        roster.sessions[0].should_resume = true;
        roster.sessions[0].in_flight.streaming = true;
        let progress = std::sync::Arc::new(RestoreProgress::new());
        progress.begin(Some(&roster));
        let waiter = |progress: &std::sync::Arc<RestoreProgress>, selector: &str| {
            let progress = std::sync::Arc::clone(progress);
            let selector = selector.to_string();
            tokio::spawn(async move { progress.wait_for_settle_target(&selector).await })
        };
        let tick = std::time::Duration::from_millis(1);
        let mut queued_a = waiter(&progress, "a-1");
        let queued_b = waiter(&progress, "durable-b");
        // The adoption settles skip the continuation row but settle the ordinary one.
        progress.settle_adopted("a-1");
        progress.settle_adopted("durable-b");
        assert!(tokio::time::timeout(tick, queued_b).await.is_ok());
        assert!(tokio::time::timeout(tick, &mut queued_a).await.is_err());
        // The pass's own settle is unconditional.
        progress.settle_target("a-1", None);
        assert!(tokio::time::timeout(tick, queued_a).await.is_ok());
    }

    #[test]
    fn legacy_adoption_waits_for_manifest_queue_replay_even_when_idle() {
        let mut roster = two_row_roster();
        roster.rest.insert("legacy_ts_restart".into(), json!(true));
        let progress = RestoreProgress::new();
        progress.begin(Some(&roster));
        progress.settle_adopted("a-1");
        assert!(!progress.state.lock().unwrap().targets["a-1"].settled);
        progress.settle_target("a-1", None);
        assert!(progress.state.lock().unwrap().targets["a-1"].settled);
    }

    #[tokio::test(start_paused = true)]
    async fn a_continuation_skip_is_still_progress_for_the_other_waiters() {
        let mut roster = two_row_roster();
        roster.sessions[0].should_resume = true;
        roster.sessions[0].in_flight.streaming = true;
        roster.sessions[1].should_resume = true;
        roster.sessions[1].in_flight.streaming = true;
        let progress = std::sync::Arc::new(RestoreProgress::new());
        progress.begin(Some(&roster));
        let waiter = |progress: &std::sync::Arc<RestoreProgress>, selector: &str| {
            let progress = std::sync::Arc::clone(progress);
            let selector = selector.to_string();
            tokio::spawn(async move { progress.wait_for_settle_target(&selector).await })
        };
        let mut queued_a = waiter(&progress, "a-1");
        let tick = std::time::Duration::from_millis(1);
        assert!(tokio::time::timeout(tick, &mut queued_a).await.is_err());
        // Quiet for 110s, then an adoption brings a continuation row up:
        // the skipped settle still counts as progress (re-arms the budget).
        tokio::time::advance(std::time::Duration::from_secs(110)).await;
        progress.settle_adopted("durable-b");
        // Past the original deadline: only the re-arm keeps the waiter queued.
        tokio::time::advance(std::time::Duration::from_secs(30)).await;
        assert!(
            tokio::time::timeout(tick, &mut queued_a).await.is_err(),
            "the skipped settle did not re-arm the other waiters"
        );
        progress.settle_target("a-1", None);
        assert!(tokio::time::timeout(tick, queued_a).await.is_ok());
    }

    #[tokio::test(start_paused = true)]
    async fn settle_progress_rearms_a_waiters_quiet_budget_past_the_first_deadline() {
        let progress = std::sync::Arc::new(RestoreProgress::new());
        progress.begin(Some(&two_row_roster()));
        let waiter = |progress: &std::sync::Arc<RestoreProgress>, selector: &str| {
            let progress = std::sync::Arc::clone(progress);
            let selector = selector.to_string();
            tokio::spawn(async move { progress.wait_for_settle_target(&selector).await })
        };
        let mut queued_a = waiter(&progress, "a-1");
        let tick = std::time::Duration::from_millis(1);
        assert!(tokio::time::timeout(tick, &mut queued_a).await.is_err());
        // Quiet for 110s (budget 120s), then one unrelated settle:
        // the budget re-arms instead of expiring.
        tokio::time::advance(std::time::Duration::from_secs(110)).await;
        progress.settle_target("b-2", None);
        tokio::time::advance(std::time::Duration::from_secs(30)).await;
        assert!(
            tokio::time::timeout(tick, &mut queued_a).await.is_err(),
            "the waiter expired on the original deadline instead of the re-armed one"
        );
        tokio::time::advance(std::time::Duration::from_secs(40)).await;
        progress.settle_target("alpha", None);
        assert!(tokio::time::timeout(tick, queued_a).await.is_ok());
    }

    #[test]
    fn settle_target_without_a_registered_pass_is_a_no_op() {
        let progress = RestoreProgress::new();
        // No pass began: the settle must be a silent no-op.
        progress.settle_target("a-1", None);
        progress.settle_target("a-1", Some("never happens".to_string()));
        assert!(progress.settled_failure("a-1").is_none());
    }

    #[test]
    fn restore_rows_sort_bottom_up_deepest_first() {
        let row = |id: &str, depth: u32, subagent: bool| UpdateRosterSession {
            session_id: id.to_string(),
            active_session_id: format!("active-{id}"),
            session_file: format!("/sessions/{id}.jsonl"),
            name: None,
            kind: if subagent {
                pa_types::daemon::update_flow::UpdateRosterSessionKind::Subagent
            } else {
                pa_types::daemon::update_flow::UpdateRosterSessionKind::TopLevel
            },
            parent_session_id: None,
            rlm_depth: depth,
            cwd: "/w".to_string(),
            runtime_config: serde_json::json!({}),
            queue: pa_types::daemon::update_flow::UpdateRosterQueue {
                next_turn: Vec::new(),
                actions: serde_json::json!({}),
            },
            in_flight: pa_types::daemon::update_flow::UpdateRosterInFlight::default(),
            should_resume: false,
            rest: Map::default(),
        };
        let owned = [
            row("top", 0, false),
            row("child", 1, true),
            row("grandchild", 2, true),
        ];
        let mut rows: Vec<&UpdateRosterSession> = owned.iter().collect();
        sort_rows_bottom_up(&mut rows);
        let ids: Vec<&str> = rows.iter().map(|row| row.session_id.as_str()).collect();
        assert_eq!(ids, ["grandchild", "child", "top"]);
    }

    #[test]
    fn settled_failure_matches_durable_active_and_stem_selectors() {
        let progress = RestoreProgress::new();
        let roster: UpdateRoster = serde_json::from_value(serde_json::json!({
            "format_version": 1,
            "update_id": "u-1",
            "socket_path": "/tmp/s.sock",
            "created_at": "2026-01-01T00:00:00Z",
            "supervisor": { "pid": 1, "process_start_id": "p", "generation": "g" },
            "binary": { "from_version": "0.1", "to_version": "0.2" },
            "sessions": [{
                "session_id": "durable-1",
                "active_session_id": "active-1",
                "session_file": "/sessions/durable-1.jsonl",
                "kind": "top-level",
                "rlm_depth": 0,
                "cwd": "/w",
                "runtime_config": {},
                "queue": { "next_turn": [], "actions": {} },
                "in_flight": {
                    "streaming": false, "compacting": false, "bash_running": false,
                    "rlm_children": false, "retrying": false, "prompt_in_flight": false
                },
                "should_resume": false
            }],
        }))
        .unwrap();
        progress.register_targets(&roster);
        progress.settle(
            UpdateStatusCounts {
                total: 1,
                failed: 1,
                ..Default::default()
            },
            vec![UpdateStatusFailure {
                session_file: "/sessions/durable-1.jsonl".to_string(),
                message: "worker create failed".to_string(),
            }],
        );
        for selector in ["durable-1", "active-1"] {
            let (file, message) = progress.settled_failure(selector).unwrap();
            assert_eq!(file, "/sessions/durable-1.jsonl");
            assert_eq!(message, "worker create failed");
        }
        assert!(progress.settled_failure("unknown-id").is_none());
    }

    #[test]
    fn boot_sweep_removes_socket_dir_and_legacy_names() {
        let dir = tempfile::TempDir::new().unwrap();
        let agent_dir = dir.path().join("agent");
        let socket = dir.path().join("daemon.sock");
        let socket_hash = crate::paths::hash_key(&socket.to_string_lossy(), 64);
        let scratch = socket_update_dir(&agent_dir, &socket_hash);
        std::fs::create_dir_all(scratch.join("prepared/u-1")).unwrap();
        std::fs::create_dir_all(legacy_update_restarts_dir(&agent_dir)).unwrap();
        std::fs::write(legacy_update_restart_status(&agent_dir), "{}").unwrap();
        let ts_record = pa_types::daemon::update_flow::update_restarts_dir(&agent_dir)
            .join("3c5dcf39f81bbe22-4e3a8d9e-1f2b-4c5d-9a0b-c1d2e3f4a5b6.json");
        std::fs::write(&ts_record, "{}").unwrap();
        let other_socket_dir =
            pa_types::daemon::update_flow::update_restarts_dir(&agent_dir).join("0f".repeat(32));
        std::fs::create_dir_all(other_socket_dir.join("prepared")).unwrap();
        boot_sweep(&agent_dir, &socket);
        assert!(!scratch.exists());
        assert!(!legacy_update_restarts_dir(&agent_dir).exists());
        assert!(!legacy_update_restart_status(&agent_dir).exists());
        assert_eq!(std::fs::read_to_string(&ts_record).unwrap(), "{}");
        assert!(other_socket_dir.exists());
    }

    #[test]
    fn boot_sweep_preserves_socket_bound_lost_reply_sources_until_attempts_finish() {
        let dir = tempfile::TempDir::new().unwrap();
        let agent_dir = dir.path().join("agent");
        let socket = dir.path().join("daemon.sock");
        let other_socket = dir.path().join("other.sock");
        let sources = legacy_update_restarts_dir(&agent_dir);
        let recovery = agent_dir.join("legacy-update-recovery");
        std::fs::create_dir_all(&sources).unwrap();
        std::fs::create_dir_all(&recovery).unwrap();
        let mut attempts = Vec::new();
        let mut manifests = Vec::new();
        for pending_socket in [&socket, &other_socket] {
            let key = crate::paths::hash_key(&pending_socket.to_string_lossy(), 64);
            let attempt = recovery.join(format!("{key}.attempt.json"));
            let manifest = sources.join(format!("{key}.json"));
            std::fs::write(&attempt, serde_json::to_vec(&json!({
                "socket": pending_socket, "version": "older-target-version", "updateId": "pending",
                "startedAt": 123, "previousDigest": null, "origin": null,
                "hello": { "supervisorPid": 42, "supervisorProcessStartId": "start",
                    "supervisorGeneration": "generation" }
            })).unwrap()).unwrap();
            std::fs::write(&manifest, "prepared TS session and queue snapshot").unwrap();
            attempts.push(attempt);
            manifests.push(manifest);
        }
        let checkpoint = recovery.join("retained-checkpoint.json");
        std::fs::write(&checkpoint, "converted roster").unwrap();
        let stale = sources.join("unrelated.json");
        std::fs::write(&stale, "stale snapshot").unwrap();
        // A marker at the wrong key cannot preserve an unrelated source.
        std::fs::copy(&attempts[0], recovery.join("unrelated.attempt.json")).unwrap();
        let malformed = sources.join("malformed.json");
        std::fs::write(&malformed, "stale snapshot").unwrap();
        std::fs::write(recovery.join("malformed.attempt.json"), "not JSON").unwrap();
        boot_sweep(&agent_dir, &socket);
        assert_eq!(
            manifests
                .iter()
                .map(std::fs::read_to_string)
                .collect::<std::io::Result<Vec<_>>>()
                .unwrap(),
            [
                "prepared TS session and queue snapshot",
                "prepared TS session and queue snapshot"
            ]
        );
        assert!(!stale.exists());
        assert!(!malformed.exists());
        assert!(attempts.iter().all(|path| path.exists()));
        assert_eq!(
            std::fs::read_to_string(&checkpoint).unwrap(),
            "converted roster"
        );

        // Successful coordinator adoption removes its attempt. A later boot can
        // sweep that source without destroying another socket's pending recovery.
        std::fs::remove_file(&attempts[0]).unwrap();
        boot_sweep(&agent_dir, &socket);
        assert!(!manifests[0].exists());
        assert_eq!(
            std::fs::read_to_string(&manifests[1]).unwrap(),
            "prepared TS session and queue snapshot"
        );
        std::fs::remove_file(&attempts[1]).unwrap();
        boot_sweep(&agent_dir, &socket);
        assert!(!sources.exists());
        assert_eq!(
            std::fs::read_to_string(checkpoint).unwrap(),
            "converted roster"
        );
    }

    #[test]
    fn consume_roster_env_none_without_the_env() {
        // NOTE: process env is global; this documents the None path only when no
        // other test set the var.
        if std::env::var(UPDATE_ROSTER_ENV).is_err() {
            assert!(consume_roster_env().is_none());
        }
    }
}
