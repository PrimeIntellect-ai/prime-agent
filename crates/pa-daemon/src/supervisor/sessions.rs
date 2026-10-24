//! The saved-session surfaces: the `list`/`list_saved_sessions`/`create`
//! handlers, the stale-id binding and rebind seam, and the saved-row
//! builders.
use super::{
    anyhow, bail, json, list_sessions, mpsc, name_unavailable_error, paths, reservation_key,
    response_failure, response_line, response_success, subscribers, Arc, DaemonCommand,
    DaemonResponse, DaemonSessionLifecycle, NameScope, Outbound, Path, PathBuf, ResidentWorker,
    Result, RouteAdmission, Supervisor, Value, ROUTE_TIMEOUT_MS,
};
use crate::session_scan::list_sessions_with;

/// One spawn-name reservation held across a fresh-launch create (TS #2396): the only
/// cross-create serializer for a same-name admission.
struct CreateNameReservation {
    supervisor: Arc<Supervisor>,
    key: String,
}

impl Drop for CreateNameReservation {
    fn drop(&mut self) {
        self.supervisor
            .pending_session_names
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(&self.key);
    }
}

impl Supervisor {
    /// Record one session binding (the stale-id rebind table). A supersede notifies the
    /// attached clients through the `session_binding` event, so they re-attach.
    pub(super) fn record_session_binding(
        &self,
        active_session_id: &str,
        session_id: Option<&str>,
        session_file: Option<&str>,
    ) {
        if let Some((previous_ids, binding)) =
            self.session_bindings
                .record(active_session_id, session_id, session_file)
        {
            for previous in previous_ids {
                self.log_line(&format!(
                    "session binding superseded: {previous} -> {} (file {:?})",
                    binding.active_session_id, binding.session_file
                ));
                let event = json!({
                    "type": "session_binding",
                    "previousActiveSessionId": previous,
                    "activeSessionId": binding.active_session_id,
                    "sessionId": binding.session_id,
                    "sessionFile": binding.session_file,
                });
                self.publish_session_event(&previous, &std::sync::Arc::new(event));
            }
        }
    }

    /// Retarget one connection at a session's current resident after its selector was
    /// superseded: the connection keeps its prior attached-ness, and a previously-attached
    /// client is told where it now points. A Detach never reaches the rebind.
    pub(crate) async fn rebind_connection(
        &self,
        selector: &str,
        resident: &Arc<ResidentWorker>,
        attached: &Arc<subscribers::ClientSubscriptions>,
    ) -> String {
        let current = resident.worker_id.clone();
        self.log_line(&format!(
            "rebinding stale session id {selector} -> {current}"
        ));
        self.note_daemon_event("session_rebound", None);
        let was_attached = attached.rebind(&self.session_subscribers, selector, &current);
        if was_attached {
            let (session_id, session_file) = {
                let descriptor = resident.descriptor.lock().await;
                (
                    descriptor.root_session_id.clone(),
                    descriptor.session_file.clone(),
                )
            };
            self.publish_session_event(
                &current,
                &std::sync::Arc::new(json!({
                    "type": "session_binding",
                    "previousActiveSessionId": selector,
                    "activeSessionId": current,
                    "sessionId": session_id,
                    "sessionFile": session_file,
                })),
            );
        }
        current
    }

    /// The current resident a superseded selector rebinds to: the binding table maps the
    /// selector to its durable identity, the registry holds its resident. `None` keeps the
    /// unknown-selector failure.
    pub(crate) async fn binding_target(&self, selector: &str) -> Option<Arc<ResidentWorker>> {
        let binding = self.session_bindings.binding_for(selector)?;
        // A binding without a session id identifies no durable session: its create
        // never completed, and whatever later owns the file path is a different
        // session — rebinding into it is the foreign-session hazard.
        let binding_session_id = binding.session_id.as_deref()?.to_string();
        let session_file = binding.session_file.as_deref()?.to_string();
        let resident = self.registry.find_by_session_file(&session_file).await?;
        // The resident must BE the binding's session, not merely hold its file: a
        // reused path must not let one session's stale ids rebind into the
        // different session that now owns the path.
        let resident_session = resident.descriptor.lock().await.root_session_id.clone();
        if resident_session.as_deref() != Some(binding_session_id.as_str()) {
            return None;
        }
        // Only a connected resident rebinds: one mid-teardown would answer the
        // not-connected error instead of the unknown-session failure the client can act on.
        if resident.cmd_tx.lock().await.is_none() {
            return None;
        }
        // Only a session-ready resident rebinds: a replacement's command channel exists
        // before its create replay finishes, so a mid-replay route would bounce off the
        // created gate.
        if !resident.route_state().session_ready {
            return None;
        }
        Some(resident)
    }

    /// `list_saved_sessions`: stream `session_list_item`/`session_list_progress` events,
    /// then a final response with the walked rows, the files left after them
    /// (`remaining`), and the `nextCursor` that resumes the walk.
    pub(super) async fn handle_saved_session_list(
        self: &Arc<Self>,
        command: &DaemonCommand,
        command_id: &str,
        stream: &tokio::sync::mpsc::Sender<(Vec<Outbound>, bool)>,
    ) -> Vec<Value> {
        let DaemonCommand::ListSavedSessions {
            cwd,
            session_dir,
            active_session_id,
            scope,
            limit,
            cursor,
            ..
        } = command
        else {
            return Vec::new();
        };
        // Session-addressed form: use the live worker's cwd and session dir.
        let (cwd, session_dir) = if let Some(active_session_id) = active_session_id {
            let resident = self.registry.get(active_session_id).await;
            match resident {
                Some(resident) => {
                    let descriptor = resident.descriptor.lock().await;
                    let cwd = descriptor
                        .create_command
                        .rest
                        .get("cwd")
                        .and_then(Value::as_str)
                        .unwrap_or("/")
                        .to_string();
                    let session_dir = descriptor
                        .create_command
                        .rest
                        .get("sessionDir")
                        .and_then(Value::as_str)
                        .map(str::to_string);
                    (cwd, session_dir)
                }
                None => {
                    return vec![response_line(&response_failure(
                        Some(command_id),
                        "list_saved_sessions",
                        &format!("Unknown active session: {active_session_id}"),
                        None,
                    ))];
                }
            }
        } else {
            let Some(cwd) = cwd else {
                // The TS supervisor runs Node's path.resolve on the
                // missing cwd; reproduce the observable error string.
                return vec![response_line(&response_failure(
                    Some(command_id),
                    "list_saved_sessions",
                    "The \"paths[0]\" property must be of type string, got undefined",
                    None,
                ))];
            };
            (cwd.clone(), session_dir.clone())
        };
        let dir = match session_dir.as_deref() {
            Some(dir) => crate::paths::expand_tilde(dir),
            None => crate::paths::sessions_dir(&self.options.agent_dir),
        };
        let dir = match dir {
            Ok(dir) => dir,
            Err(error) => {
                return vec![response_line(&response_failure(
                    Some(command_id),
                    "list_saved_sessions",
                    &error.to_string(),
                    None,
                ))];
            }
        };
        let scope_current = scope.as_str() == Some("current");
        // The catalog streams WHILE the scan runs: the frames ride the SAME channel the final
        // response travels, so the stream stays ordered; the fold runs on the blocking pool,
        // so a grown store never head-of-lines a runtime worker.
        let stream_rows = stream.clone();
        let scan_command_id = command_id.to_string();
        let scan_active_session_id = active_session_id.clone();
        let scan_cwd = cwd.clone();
        let agent_dir = self.options.agent_dir.clone();
        let cursor = cursor.clone();
        let limit = limit.map(|limit| limit as usize);
        let scan = tokio::task::spawn_blocking(move || {
            let persistent_shells =
                crate::persistent_shells::live_shell_rows_by_session(&agent_dir);
            let mut file_total = 0usize;
            let page = list_sessions_with(&dir, cursor.as_deref(), limit, |index, total, info| {
                file_total = total;
                if scope_current && info.cwd != scan_cwd {
                    // The row is out of scope, but the scan itself goes on.
                    return true;
                }
                let row = saved_session_row(info, &persistent_shells);
                let mut item = json!({
                    "id": scan_command_id,
                    "type": "session_list_item",
                    "command": "list_saved_sessions",
                    "session": row,
                });
                if let Some(active_session_id) = scan_active_session_id.as_deref() {
                    item["activeSessionId"] = json!(active_session_id);
                }
                let mut progress = json!({
                    "id": scan_command_id,
                    "type": "session_list_progress",
                    "command": "list_saved_sessions",
                    "loaded": index + 1,
                    "total": total,
                });
                if let Some(active_session_id) = scan_active_session_id.as_deref() {
                    progress["activeSessionId"] = json!(active_session_id);
                }
                // A failed send is the connection loop's death notice: the callback stops the
                // scan. The blocking-pool scan never waits on client I/O: a FULL queue skips
                // the PROGRESS frame first, a still-full queue skips the row too.
                let mut bundle = (vec![Outbound::Line(item), Outbound::Line(progress)], false);
                loop {
                    match stream_rows.try_send(bundle) {
                        Ok(()) => break true,
                        Err(mpsc::error::TrySendError::Full((mut unsent, stopped))) => {
                            if unsent.len() > 1 {
                                unsent.pop();
                                bundle = (unsent, stopped);
                                continue;
                            }
                            break true;
                        }
                        Err(mpsc::error::TrySendError::Closed(_)) => break false,
                    }
                }
            });
            (page, file_total, persistent_shells)
        });
        let (page, file_total, persistent_shells) = match scan.await {
            Ok(scanned) => scanned,
            Err(error) => {
                return vec![response_line(&response_failure(
                    Some(command_id),
                    "list_saved_sessions",
                    &format!("the saved-session scan failed: {error}"),
                    None,
                ))];
            }
        };
        // The scan's parse trees folded and freed inside the blocking task; return their
        // arena high-water to the OS at the phase boundary (live cache untouched).
        pa_types::memory_release::trim_freed_heap();
        let crate::session_scan::SessionPage {
            mut infos,
            remaining,
            next_cursor,
        } = page;
        // The current-cwd scope keeps only the session's own rows in the terminal
        // array: the response is the authoritative catalog.
        if scope_current {
            infos.retain(|info| info.cwd == cwd);
        }
        // The saved catalog scan never visits session-artifacts, where RLM children
        // persist: merge the passive ledger walk so a passivated descendant stays
        // catalog-visible.
        let mut roots: Vec<crate::rlm_roster::RosterWalkRoot> = infos
            .iter()
            .map(|info| crate::rlm_roster::RosterWalkRoot {
                session_file: info.path.clone(),
                active_session_id: None,
            })
            .collect();
        for resident in self.registry.list().await {
            let descriptor = resident.descriptor.lock().await;
            if let Some(session_file) = &descriptor.session_file {
                roots.push(crate::rlm_roster::RosterWalkRoot {
                    session_file: crate::lease::canonical_session_path(Path::new(session_file)),
                    active_session_id: Some(descriptor.root_active_session_id.clone()),
                });
            }
        }
        let ledger = match self.rlm_spawn_ledger_for(session_dir.as_deref()).await {
            Ok(ledger) => ledger,
            Err(error) => {
                return vec![response_line(&response_failure(
                    Some(command_id),
                    "list_saved_sessions",
                    &error.to_string(),
                    None,
                ))];
            }
        };
        let passive = match crate::rlm_roster::walk_passive_rlm_children(&ledger, &roots) {
            Ok(children) => children,
            Err(error) => {
                self.log_line(&format!(
                    "Could not merge passive RLM descendants: {error:#}"
                ));
                Vec::new()
            }
        };
        // The passive ledger children stream too (items only, no progress - the
        // saved phase above owns the progress counts).
        let mut merged: Vec<_> = passive
            .iter()
            .map(crate::rlm_roster::passive_child_info)
            .filter(|info| !scope_current || info.cwd == cwd)
            .collect();
        for info in &merged {
            let row = saved_session_row(info, &persistent_shells);
            let mut item = json!({
                "id": command_id,
                "type": "session_list_item",
                "command": "list_saved_sessions",
                "session": row,
            });
            if let Some(active_session_id) = active_session_id {
                item["activeSessionId"] = json!(active_session_id);
            }
            let _ = stream.send((vec![Outbound::Line(item)], false)).await;
        }
        infos.append(&mut merged);
        // Every row carries its tombstoned descendants' spend, attached by canonical
        // parent path so the rollup bills deleted subagents to the parent that spent them.
        match ledger.deleted_descendant_usage_by_parent() {
            Ok(bucket) => {
                for info in &mut infos {
                    let path = crate::lease::canonical_session_path(&info.path)
                        .to_string_lossy()
                        .to_string();
                    info.deleted_descendant_usage = bucket.get(&path).cloned();
                }
            }
            Err(error) => {
                self.log_line(&format!(
                    "Could not attach deleted-descendant usage: {error:#}"
                ));
            }
        }
        // The scan's completion marker: the progress counts DIRECTORY entries while rows
        // only stream for valid files, so the last progress can land short of the total; a
        // consumer waiting for `loaded == total` observes completion on the final frame.
        if file_total > 0 {
            let mut completion = json!({
                "id": command_id,
                "type": "session_list_progress",
                "command": "list_saved_sessions",
                "loaded": file_total,
                "total": file_total,
            });
            if let Some(active_session_id) = active_session_id {
                completion["activeSessionId"] = json!(active_session_id);
            }
            let _ = stream.send((vec![Outbound::Line(completion)], false)).await;
        }
        // The streamed rows already reached the client; the terminal response is
        // the authoritative array (the scan never re-orders after streaming).
        let mut lines = Vec::new();
        let sessions: Vec<Value> = infos
            .iter()
            .map(|info| saved_session_row(info, &persistent_shells))
            .collect();
        let mut data = json!({ "sessions": sessions, "remaining": remaining });
        if let Some(next_cursor) = next_cursor {
            data["nextCursor"] = json!(next_cursor);
        }
        lines.push(response_line(&response_success(
            Some(command_id),
            "list_saved_sessions",
            Some(data),
        )));
        // Telemetry: how many served rows carry a usage summary (a count only,
        // never session payload).
        let rows_with_usage = infos.iter().filter(|info| info.usage.is_some()).count();
        self.note_saved_sessions_listed(rows_with_usage);
        lines
    }

    pub(super) async fn handle_list(
        self: &Arc<Self>,
        command_id: String,
        type_name: String,
        all: Option<bool>,
        cwd: Option<String>,
        session_dir: Option<String>,
    ) -> DaemonResponse {
        let dir = match session_dir.as_deref() {
            Some(dir) => paths::expand_tilde(dir),
            None => paths::sessions_dir(&self.options.agent_dir),
        };
        let dir = match dir {
            Ok(dir) => dir,
            Err(error) => {
                return response_failure(Some(&command_id), &type_name, &error.to_string(), None);
            }
        };
        let summaries: Vec<Value> = if let Some(true) = all {
            // TS `buildSessionList` order: saved rows (resident ones replaced in place by
            // their live summary), then passive children, then resident-only rows.
            let mut residents = Vec::new();
            let mut resident_roots = Vec::new();
            for resident in self.registry.list().await {
                let descriptor = resident.descriptor.lock().await;
                if let Some(session_file) = &descriptor.session_file {
                    residents.push(Arc::clone(&resident));
                    // Resident roots carry their active session id so passive children of a
                    // resident parent report parentActiveSessionId.
                    resident_roots.push((
                        session_file.clone(),
                        descriptor.root_active_session_id.clone(),
                    ));
                }
            }
            let summaries_by_resident = self.resident_summaries(&residents).await;
            let ledger = match self.rlm_spawn_ledger_for(session_dir.as_deref()).await {
                Ok(ledger) => ledger,
                Err(error) => {
                    return response_failure(
                        Some(&command_id),
                        &type_name,
                        &error.to_string(),
                        None,
                    );
                }
            };
            let scan = tokio::task::spawn_blocking(move || -> Result<Vec<Value>> {
                let mut infos = list_sessions(&dir);
                if let Some(cwd) = &cwd {
                    infos.retain(|info| info.cwd == *cwd);
                }
                let mut resident_by_file: Vec<ResidentRoot> = Vec::new();
                for ((session_file, active_session_id), summary) in
                    resident_roots.into_iter().zip(summaries_by_resident)
                {
                    resident_by_file.push(ResidentRoot {
                        session_file: crate::lease::canonical_session_path(Path::new(
                            &session_file,
                        )),
                        summary,
                        active_session_id: Some(active_session_id),
                    });
                }
                let mut summaries = Vec::new();
                let mut roots: Vec<crate::rlm_roster::RosterWalkRoot> = Vec::new();
                for info in &infos {
                    roots.push(crate::rlm_roster::RosterWalkRoot {
                        session_file: info.path.clone(),
                        active_session_id: None,
                    });
                    let canonical = crate::lease::canonical_session_path(&info.path);
                    let resident = resident_by_file
                        .iter()
                        .position(|root| root.session_file == canonical)
                        .map(|at| resident_by_file.swap_remove(at));
                    match resident {
                        Some(root) => {
                            roots.last_mut().expect("saved root").active_session_id =
                                root.active_session_id;
                            summaries.push(root.summary);
                        }
                        None => summaries.push(saved_session_summary(info)),
                    }
                }
                let mut resident_only = Vec::new();
                for root in resident_by_file {
                    roots.push(crate::rlm_roster::RosterWalkRoot {
                        session_file: root.session_file,
                        active_session_id: root.active_session_id,
                    });
                    resident_only.push(root.summary);
                }
                match crate::rlm_roster::walk_passive_rlm_children(&ledger, &roots) {
                    Ok(children) => {
                        for child in &children {
                            summaries.push(crate::rlm_roster::passive_child_summary(child));
                        }
                    }
                    Err(error) => {
                        return Err(anyhow!("Could not walk passive RLM children: {error:#}"));
                    }
                }
                summaries.append(&mut resident_only);
                Ok(summaries)
            });
            match scan.await {
                Ok(Ok(summaries)) => summaries,
                Ok(Err(message)) => {
                    let message = message.to_string();
                    self.log_line(&message);
                    return response_failure(Some(&command_id), &type_name, &message, None);
                }
                Err(error) => {
                    return response_failure(
                        Some(&command_id),
                        &type_name,
                        &format!("the saved-session scan failed: {error}"),
                        None,
                    );
                }
            }
        } else {
            // Live residents of this supervisor.
            let residents = self.registry.list().await;
            self.resident_summaries(&residents).await
        };
        response_success(
            Some(&command_id),
            &type_name,
            Some(json!({ "sessions": summaries })),
        )
    }

    /// One resident's list row: the cached live summary the roster pipeline
    /// keeps fresh (the worker's own pushes plus the authoritative
    /// registration/adoption/create/wake pulls), never a per-list `get_state`
    /// round-trip — the summary budget a busy worker used to hold the whole
    /// list against. A resident with no cached summary (its registration pull
    /// failed and it never pushed) serves the degraded offline row without the
    /// wait, keeping the supervisor's trusted family binding for that worker.
    async fn resident_summary(&self, resident: &Arc<ResidentWorker>) -> Value {
        let cached = resident.summary_snapshot.lock().unwrap().clone();
        if let Some(summary) = cached {
            return summary;
        }
        let root_active_session_id = resident
            .descriptor
            .lock()
            .await
            .root_active_session_id
            .clone();
        let roster = self
            .roster
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut summary = offline_summary(&resident.worker_id);
        // A missing live summary loses activity, not the family binding. Never
        // borrow identity from a row now owned by another worker.
        if let Some(entry) = roster
            .by_active_session_id(&root_active_session_id)
            .filter(|entry| entry.worker_id.as_deref() == Some(resident.worker_id.as_str()))
        {
            for key in [
                "parentActiveSessionId",
                "parentSessionId",
                "parentSessionPath",
                "sessionName",
            ] {
                if let Some(value) = entry.summary.get(key) {
                    summary[key] = value.clone();
                }
            }
        }
        summary
    }

    async fn resident_summaries(&self, residents: &[Arc<ResidentWorker>]) -> Vec<Value> {
        let mut summaries = Vec::with_capacity(residents.len());
        for resident in residents {
            summaries.push(self.resident_summary(resident).await);
        }
        summaries
    }

    pub(crate) async fn handle_create(
        self: &Arc<Self>,
        command: &DaemonCommand,
        client_id: String,
    ) -> Result<Value> {
        // The per-file open single-flight: a concurrent open waits behind this one and then
        // reuses the worker it launched (both launches would race the session lease).
        let opening_guard = self.opening_guard(command).await?;
        // The reuse seam: an open of a file a live worker already serves answers the LIVE
        // binding instead of launching a second worker; it runs BEFORE the name check.
        if let Some(summary) = self
            .reuse_live_worker_for_create(command, &client_id)
            .await?
        {
            return Ok(summary);
        }
        // TS `createRlmSubagentRuntime` (#2396): the sibling name is held under a daemon-wide
        // reservation for the whole admission, so a same-name sibling landing mid-admission
        // fails closed. Only a `kind: "subagent"` create reserves; the binding owns the guard.
        let _name_reservation = self.reserve_subagent_create_name(command)?;
        if let DaemonCommand::Create {
            name: Some(name), ..
        } = command
        {
            self.assert_session_name_available(name).await?;
        }
        // Only a `client_owned`-lifecycle create is client-owned; unspecified and `Resident`
        // are unowned. RLM child spawns declare `Resident`, so a spawned child never
        // inherits the client's ownership (an owned child's rows would die with a stop).
        let create_lifecycle = match command {
            DaemonCommand::Create { lifecycle, .. } => *lifecycle,
            _ => None,
        };
        let owner_client_id = match create_lifecycle {
            Some(DaemonSessionLifecycle::ClientOwned) => Some(client_id),
            _ => None,
        };
        let (resident, create_summary) = self.launch_worker(command, owner_client_id).await?;
        // The single-flight stays held through the spawn admission below: an admission
        // failure tears the resident down, and a concurrent open that had just reused it
        // would hold a summary for a gone worker. The ledger is the only topology store.
        if let Err(error) = self
            .record_rlm_child_admission(command, &create_summary)
            .await
        {
            // Never leave an admitted-but-unrecorded child running: the
            // ledger is the only topology store.
            let _ = self.stop_worker(&resident).await;
            return Err(error);
        }
        // The admission settled: the single-flight may release (a
        // concurrent open's classification now finds a durable resident).
        drop(opening_guard);
        // Prefer a fresh get_state, but a degraded one falls back to the authoritative
        // create summary instead of failing the spawn.
        let summary = match self
            .route_command_typed(
                &resident,
                "get_state",
                json!({}),
                ROUTE_TIMEOUT_MS,
                RouteAdmission::SupervisorInternal,
            )
            .await
        {
            Ok(response) if response.success => {
                response.data.unwrap_or_else(|| create_summary.clone())
            }
            _ => create_summary.clone(),
        };
        // The new session joins the agent roster immediately, as an authoritative pull
        // write (its counter raises the resident's stale-delta watermark).
        self.write_roster_summary_for_resident(&resident, &summary)
            .await;
        // The new root's passive family renders immediately from the ledger edges, then
        // one bounded background hydration fills each seeded row's display fields. The root
        // is the CREATE response's session file (a mid-replay get_state must not skip it).
        if let Some(root) = summary
            .get("sessionFile")
            .and_then(Value::as_str)
            .or_else(|| create_summary.get("sessionFile").and_then(Value::as_str))
        {
            let seeded = self.seed_roster_family_edges(Path::new(&root)).await;
            if !seeded.is_empty() {
                self.spawn_seeded_hydration(seeded);
            }
        }
        Ok(summary)
    }

    async fn assert_session_name_available(self: &Arc<Self>, name: &str) -> Result<()> {
        if name.trim().is_empty() {
            return Err(anyhow!("Session name cannot be empty"));
        }
        let residents = self.registry.list().await;
        for summary in self.resident_summaries(&residents).await {
            let session_name = summary
                .get("sessionName")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if session_name == name {
                return Err(anyhow!(
                    "Agent name \"{name}\" is unavailable: an agent of that name already exists at depth 0 under this parent"
                ));
            }
        }
        Ok(())
    }

    /// Reserve a subagent spawn's name for the whole fresh-launch admission (TS #2396):
    /// non-reserving creates answer `None`; a racing same-name admission fails closed.
    fn reserve_subagent_create_name(
        self: &Arc<Self>,
        command: &DaemonCommand,
    ) -> Result<Option<CreateNameReservation>> {
        let DaemonCommand::Create {
            name,
            runtime_metadata,
            ..
        } = command
        else {
            return Ok(None);
        };
        let (Some(name), Some(metadata)) = (name, runtime_metadata) else {
            return Ok(None);
        };
        if metadata.get("kind").and_then(Value::as_str) != Some("subagent") {
            return Ok(None);
        }
        // The child's scope keys the reservation exactly like a rename's: `[depth, parent,
        // name]`, the parent keyed by its session file when it has one.
        let scope = NameScope {
            id: String::new(),
            name: name.clone(),
            depth: metadata
                .get("rlmDepth")
                .and_then(Value::as_u64)
                .unwrap_or(1) as u32,
            parent_session_id: metadata
                .get("parentSessionId")
                .and_then(Value::as_str)
                .map(str::to_string),
            parent_session_path: metadata
                .get("parentSessionFile")
                .and_then(Value::as_str)
                .map(str::to_string),
        };
        let key = reservation_key(&scope);
        let reserved = self
            .pending_session_names
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(key.clone());
        if !reserved {
            bail!(name_unavailable_error(name, scope.depth));
        }
        Ok(Some(CreateNameReservation {
            supervisor: Arc::clone(self),
            key,
        }))
    }
}

/// One resident's roster identity for the `list --all` merge.
struct ResidentRoot {
    session_file: PathBuf,
    summary: Value,
    active_session_id: Option<String>,
}

pub(super) fn saved_session_summary(info: &crate::session_store::SessionInfo) -> Value {
    let mut row = json!({
        "id": info.id,
        // TS `inactiveLifecycleForSession`: archived/crash markers stay archived;
        // everything else is live once a message exists, draft otherwise.
        "lifecycle": match info.state.as_deref() {
            Some("archived" | "crash") => "archived",
            _ if info.message_count > 0 => "live",
            _ => "draft",
        },
        "activity": "idle",
        "isSessionActive": false,
        "activeSessionId": info.id,
        "sessionId": info.id,
        "sessionFile": info.path.to_string_lossy(),
        "sessionName": info.name,
        "cwd": info.cwd,
        "isStreaming": false,
        "isCompacting": false,
        "attachedClients": 0,
        "messageCount": info.message_count,
        "sessionActions": { "queuedCount": 0, "steering": [], "followUps": [] },
        "created": info.created,
        "modified": info.modified,
        "firstMessage": info.first_message,
        "rlmDepth": info.rlm_depth,
    });
    // TS `summaryForInactiveSession` publishes the header binding: the
    // parent path only when one is recorded (TS's `undefined` is omitted).
    if let Some(parent) = &info.parent_session_path {
        if let Some(object) = row.as_object_mut() {
            object.insert("parentSessionPath".to_string(), json!(parent));
        }
    }
    // The persisted thinking level rides every saved-session summary row: the agents-view
    // Model column renders "model:level" for sessions without a live worker.
    if let Some(level) = &info.thinking_level {
        if let Some(object) = row.as_object_mut() {
            object.insert("thinkingLevel".to_string(), json!(level));
        }
    }
    // TS `summaryForInactiveSession` publishes the scan's own-usage summary:
    // the roster record reads it before the saved catalog row's (own cost
    // `daemon.usage ?? saved.usage`), so rollups never double count.
    if let Some(usage) = &info.usage {
        if let Some(object) = row.as_object_mut() {
            object.insert("usage".to_string(), json!(usage));
        }
    }
    row
}

fn offline_summary(worker_id: &str) -> Value {
    json!({
        "id": worker_id,
        "lifecycle": "recovering",
        "activity": "idle",
        "isSessionActive": false,
        "sessionId": "",
        "cwd": "",
        "isStreaming": false,
        "isCompacting": false,
        "attachedClients": 0,
        "messageCount": 0,
        "sessionActions": { "queuedCount": 0, "steering": [], "followUps": [] },
    })
}

pub(super) fn saved_session_row(
    info: &crate::session_store::SessionInfo,
    persistent_shells: &std::collections::HashMap<String, Vec<Value>>,
) -> Value {
    let mut row = json!({
        "path": info.path.to_string_lossy(),
        "id": info.id,
        "cwd": info.cwd,
        "rlmDepth": info.rlm_depth,
        "created": info.created,
        "modified": info.modified,
        "messageCount": info.message_count,
        "firstMessage": info.first_message,
        "state": info.state.as_ref().map(|state| json!({ "status": state })),
    });
    let object = row.as_object_mut().expect("row object");
    if let Some(name) = &info.name {
        object.insert("name".to_string(), json!(name));
    }
    if let Some(parent) = &info.parent_session_path {
        object.insert("parentSessionPath".to_string(), json!(parent));
    }
    if let Some((provider, model_id)) = &info.model {
        object.insert(
            "model".to_string(),
            json!({ "provider": provider, "modelId": model_id }),
        );
    }
    // TS `serializeSavedSessionInfo` publishes the scan's own-usage summary:
    // the spend columns and the archived-row keep-condition read
    // `saved.usage.cost`, so rollups never double count.
    if let Some(usage) = &info.usage {
        object.insert("usage".to_string(), json!(usage));
    }
    // TS #2506 `serializeSavedSessionInfo`'s optional `deletedDescendantUsage`: the
    // recursive spend of tombstoned descendants — the deleted child keeps no row anywhere,
    // its spend bills here exactly once.
    if let Some(deleted) = &info.deleted_descendant_usage {
        object.insert("deletedDescendantUsage".to_string(), json!(deleted));
    }
    // The persisted thinking level rides the catalog row too: the TUI merges it into
    // live summaries that lack one.
    if let Some(level) = &info.thinking_level {
        object.insert("thinkingLevel".to_string(), json!(level));
    }
    // Persistent `bash()` shells outlive the session's kernel: an inactive row still
    // shows the live ones (kernel activity row shape).
    if let Some(shells) = persistent_shells.get(&info.id) {
        object.insert("persistentShells".to_string(), json!(shells));
    }
    row
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backpressure::WORKER_INFLIGHT_CAPACITY;
    use crate::registry::WorkerRequest;
    use crate::supervisor::SupervisorOptions;
    use crate::supervisor_roster::WorkerRosterDelta;
    use pa_types::daemon::DaemonWorkerDescriptor;

    fn resident(worker_id: &str, session_file: Option<&Path>) -> Arc<ResidentWorker> {
        let mut descriptor = json!({
            "version": 2,
            "workerId": worker_id,
            "pid": 0,
            "socketPath": "/tmp/none.sock",
            "recoveryJournalPath": "/tmp/none.jsonl",
            "supervisorSocketPath": "/tmp/none.sock",
            "authenticationToken": worker_id,
            "rootActiveSessionId": worker_id,
            "createdAt": "2026-09-26T00:00:00Z",
            "updatedAt": "2026-09-26T00:00:00Z",
            "lifecycle": "ready",
            "createCommand": {},
            "consecutiveFailures": 0,
        });
        if let Some(session_file) = session_file {
            descriptor["sessionFile"] = json!(session_file.to_string_lossy());
        }
        let descriptor: DaemonWorkerDescriptor =
            serde_json::from_value(descriptor).expect("descriptor");
        ResidentWorker::new(
            worker_id.to_string(),
            descriptor,
            PathBuf::from("/tmp/none.descriptor.json"),
        )
    }

    /// Install a live command channel nobody drains: a resident that accepts
    /// frames but never answers (the halves must outlive the routes under test).
    async fn wedged_worker(
        resident: &Arc<ResidentWorker>,
    ) -> tokio::sync::mpsc::Receiver<WorkerRequest> {
        let (cmd_tx, cmd_rx) =
            tokio::sync::mpsc::channel::<WorkerRequest>(WORKER_INFLIGHT_CAPACITY);
        *resident.cmd_tx.lock().await = Some(cmd_tx);
        cmd_rx
    }

    fn supervisor(dir: &Path) -> Supervisor {
        Supervisor::new(SupervisorOptions {
            socket_path: dir.join("daemon.sock"),
            agent_dir: dir.join("agent"),
        })
        .expect("supervisor")
    }

    /// One full live summary in the worker's push shape (the wire form
    /// `worker_roster_delta` carries): every field the list rows and the CLI's
    /// structural summary guard read.
    fn live_summary(worker_id: &str, session_file: &Path, overrides: &Value) -> Value {
        let mut summary = json!({
            "id": worker_id,
            "activeSessionId": worker_id,
            "lifecycle": "live",
            "activity": "idle",
            "isSessionActive": false,
            "sessionId": worker_id,
            "sessionFile": session_file.to_string_lossy(),
            "sessionName": format!("{worker_id}-name"),
            "cwd": "/tmp",
            "isStreaming": false,
            "isCompacting": false,
            "attachedClients": 0,
            "messageCount": 1,
            "sessionActions": { "queuedCount": 0, "steering": [], "followUps": [] },
            "model": { "provider": "openai", "id": "test-model" },
            "workerState": "ready",
        });
        if let (Some(summary), Some(overrides)) = (summary.as_object_mut(), overrides.as_object()) {
            for (key, value) in overrides {
                summary.insert(key.clone(), value.clone());
            }
        }
        summary
    }

    /// The worker's own roster push, exactly as the wire frame delivers it: the
    /// real delta handler (token-authenticated, sequence-gated) is the pipeline
    /// that keeps the resident's cached live summary fresh.
    async fn publish_roster_delta(supervisor: &Arc<Supervisor>, worker_id: &str, summary: Value) {
        let delta = WorkerRosterDelta {
            worker_token: worker_id.to_string(),
            summary,
            removed: Vec::new(),
            sequence: Some(1),
            worker_instance_id: Some("test-instance".to_string()),
        };
        let response = supervisor
            .handle_worker_roster_delta("d1", "worker_roster_delta", delta)
            .await;
        assert!(response.success, "the roster delta applied: {response:?}");
    }

    /// Register one wedged resident; the undrained channel's receive half
    /// must outlive the routes under test, so it is returned for the test to
    /// hold (a dropped receiver closes the channel and routes fail fast).
    async fn insert_wedged(
        dir: &Path,
        supervisor: &Arc<Supervisor>,
        worker_id: &str,
    ) -> tokio::sync::mpsc::Receiver<WorkerRequest> {
        let wedged = resident(worker_id, Some(&dir.join(format!("{worker_id}.jsonl"))));
        let wedged_rx = wedged_worker(&wedged).await;
        supervisor.registry.insert(wedged).await;
        wedged_rx
    }

    /// The per-resident summary budget the pre-fix list paid to a wedged
    /// worker (`SUMMARY_TIMEOUT_MS`, deleted with the live routes): the
    /// regression bound — a served list must never come near it.
    const WEDGED_SUMMARY_BUDGET: std::time::Duration = std::time::Duration::from_secs(5);

    fn list_rows(response: &DaemonResponse) -> Vec<Value> {
        assert!(response.success, "the list failed: {response:?}");
        response
            .data
            .as_ref()
            .expect("sessions data")
            .get("sessions")
            .and_then(Value::as_array)
            .cloned()
            .expect("session rows")
    }

    fn row_for<'a>(rows: &'a [Value], id: &str) -> &'a Value {
        rows.iter()
            .find(|row| row.get("id").and_then(Value::as_str) == Some(id))
            .unwrap_or_else(|| panic!("no row for {id}"))
    }

    /// The fabrication guard: a wedged (never-answering) resident that pushed a
    /// BUSY summary must keep serving that real busy row — the offline
    /// "recovering" row a summary timeout fabricates is the regression — and
    /// the list must answer inside the summary budget, not wait it out.
    #[tokio::test(start_paused = true)]
    async fn a_wedged_resident_keeps_its_pushed_busy_row_and_never_holds_the_list() {
        let dir = tempfile::TempDir::new().expect("temp dir");
        let supervisor = Arc::new(supervisor(dir.path()));
        let _w_busy_rx = insert_wedged(dir.path(), &supervisor, "w-busy").await;
        let summary = live_summary(
            "w-busy",
            &dir.path().join("w-busy.jsonl"),
            &json!({ "activity": "working", "isStreaming": true, "isSessionActive": true }),
        );
        publish_roster_delta(&supervisor, "w-busy", summary).await;

        let start = tokio::time::Instant::now();
        let response = supervisor
            .handle_list("l1".to_string(), "list".to_string(), Some(true), None, None)
            .await;
        let elapsed = start.elapsed();

        let rows = list_rows(&response);
        let busy_row = row_for(&rows, "w-busy");
        assert_eq!(
            busy_row.get("lifecycle").and_then(Value::as_str),
            Some("live"),
            "the wedged resident serves its real row, not the offline fallback: {busy_row}"
        );
        assert_eq!(
            busy_row.get("activity").and_then(Value::as_str),
            Some("working")
        );
        assert_eq!(
            busy_row.get("isStreaming").and_then(Value::as_bool),
            Some(true)
        );
        assert_eq!(
            busy_row.get("sessionName").and_then(Value::as_str),
            Some("w-busy-name")
        );
        assert_eq!(
            busy_row
                .get("sessionActions")
                .and_then(|actions| actions.get("queuedCount"))
                .and_then(Value::as_u64),
            Some(0),
            "the full summary keeps its session-action snapshot: {busy_row}"
        );
        assert!(
            elapsed < WEDGED_SUMMARY_BUDGET,
            "one wedged resident held the list for {elapsed:?}"
        );
    }

    /// An uncached resident's offline row keeps only its own worker's family
    /// binding from the supervisor roster.
    #[tokio::test(start_paused = true)]
    async fn a_degraded_summary_keeps_only_its_own_workers_family_binding() {
        let dir = tempfile::TempDir::new().expect("temp dir");
        let supervisor = Arc::new(supervisor(dir.path()));
        let resident = resident("sibling", None);
        resident.descriptor.lock().await.root_active_session_id = "sibling".to_string();
        let binding = json!({
            "activeSessionId": "sibling", "sessionId": "session-sibling",
            "sessionName": "sibling-name", "parentActiveSessionId": "parent",
            "parentSessionId": "session-parent", "parentSessionPath": "/parent.jsonl",
        });
        supervisor
            .roster
            .lock()
            .unwrap()
            .write_summary(binding.clone(), Some("sibling"), None);
        let summary = supervisor.resident_summary(&resident).await;
        let mut expected = offline_summary("sibling");
        expected["sessionName"] = binding["sessionName"].clone();
        expected["parentActiveSessionId"] = binding["parentActiveSessionId"].clone();
        expected["parentSessionId"] = binding["parentSessionId"].clone();
        expected["parentSessionPath"] = binding["parentSessionPath"].clone();
        assert_eq!(summary, expected);

        supervisor
            .roster
            .lock()
            .unwrap()
            .write_summary(binding, Some("replacement"), None);
        assert_eq!(
            supervisor.resident_summary(&resident).await,
            offline_summary("sibling")
        );
    }

    /// The non-`all` branch (the CLI's `prime-agent list` and the resume
    /// lease guard) serves the same cached rows with no worker round trips.
    #[tokio::test(start_paused = true)]
    async fn the_live_residents_list_serves_cached_rows_without_worker_round_trips() {
        let dir = tempfile::TempDir::new().expect("temp dir");
        let supervisor = Arc::new(supervisor(dir.path()));
        let _w_idle_rx = insert_wedged(dir.path(), &supervisor, "w-idle").await;
        let summary = live_summary(
            "w-idle",
            &dir.path().join("w-idle.jsonl"),
            &json!({ "activity": "idle", "isStreaming": false }),
        );
        publish_roster_delta(&supervisor, "w-idle", summary).await;

        let start = tokio::time::Instant::now();
        let response = supervisor
            .handle_list("l2".to_string(), "list".to_string(), None, None, None)
            .await;
        let elapsed = start.elapsed();

        let rows = list_rows(&response);
        let row = row_for(&rows, "w-idle");
        assert_eq!(
            row.get("sessionName").and_then(Value::as_str),
            Some("w-idle-name")
        );
        assert_eq!(row.get("activity").and_then(Value::as_str), Some("idle"));
        assert!(
            elapsed < WEDGED_SUMMARY_BUDGET,
            "the live-residents list waited {elapsed:?} behind one wedged resident"
        );
    }

    /// A resident with no cached row (its registration pull failed and it
    /// never pushed) serves today's degraded offline row immediately — the
    /// row the summary timeout used to fabricate after the full 5 s wait.
    #[tokio::test(start_paused = true)]
    async fn a_resident_without_a_cached_row_serves_the_offline_row_instantly() {
        let dir = tempfile::TempDir::new().expect("temp dir");
        let supervisor = Arc::new(supervisor(dir.path()));
        let _w_uncached_rx = insert_wedged(dir.path(), &supervisor, "w-uncached").await;

        let start = tokio::time::Instant::now();
        let response = supervisor
            .handle_list("l3".to_string(), "list".to_string(), Some(true), None, None)
            .await;
        let elapsed = start.elapsed();

        let rows = list_rows(&response);
        let row = row_for(&rows, "w-uncached");
        assert_eq!(
            row.get("lifecycle").and_then(Value::as_str),
            Some("recovering")
        );
        assert!(
            elapsed < WEDGED_SUMMARY_BUDGET,
            "the offline fallback waited {elapsed:?} on an uncached resident"
        );
    }

    /// The create-path name check reads the cached names: a wedged resident
    /// cannot hold a `create` for the summary budget, and its real session
    /// name still refuses a duplicate create.
    #[tokio::test(start_paused = true)]
    async fn a_named_create_name_check_reads_the_cached_names() {
        let dir = tempfile::TempDir::new().expect("temp dir");
        let supervisor = Arc::new(supervisor(dir.path()));
        let _w_named_rx = insert_wedged(dir.path(), &supervisor, "w-named").await;
        let summary = live_summary(
            "w-named",
            &dir.path().join("w-named.jsonl"),
            &json!({ "sessionName": "taken-name" }),
        );
        publish_roster_delta(&supervisor, "w-named", summary).await;

        let start = tokio::time::Instant::now();
        let conflict = supervisor.assert_session_name_available("taken-name").await;
        let elapsed = start.elapsed();

        assert!(
            conflict
                .unwrap_err()
                .to_string()
                .contains("Agent name \"taken-name\" is unavailable"),
            "the cached name still refuses a duplicate create"
        );
        assert!(
            elapsed < WEDGED_SUMMARY_BUDGET,
            "the name check waited {elapsed:?} behind one wedged resident"
        );
        let fresh = supervisor.assert_session_name_available("fresh-name").await;
        assert!(fresh.is_ok(), "a fresh name stays available");
    }

    /// The exact public wire line, driven through the real client connection
    /// (`handle_client` runs the hello/envelope/dispatch path): one `list`
    /// command must answer inside the summary budget while a resident worker
    /// is silent, and the silent resident's row is its pushed live summary —
    /// the desktop Cmd-R contract.
    #[cfg(unix)]
    #[tokio::test(start_paused = true)]
    async fn a_wire_list_never_waits_on_a_silent_resident_worker() {
        use pa_types::platform::transport::TransportStream;
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

        let dir = tempfile::TempDir::new().expect("temp dir");
        let supervisor = Arc::new(supervisor(dir.path()));
        let _w_silent_rx = insert_wedged(dir.path(), &supervisor, "w-silent").await;
        let _w_second_rx = insert_wedged(dir.path(), &supervisor, "w-second").await;
        let busy = live_summary(
            "w-silent",
            &dir.path().join("w-silent.jsonl"),
            &json!({ "activity": "working", "isStreaming": true, "isSessionActive": true }),
        );
        publish_roster_delta(&supervisor, "w-silent", busy).await;
        let idle = live_summary(
            "w-second",
            &dir.path().join("w-second.jsonl"),
            &json!({ "activity": "idle", "isStreaming": false }),
        );
        publish_roster_delta(&supervisor, "w-second", idle).await;

        let (server_side, client_side) = tokio::net::UnixStream::pair().expect("socket pair");
        let served = {
            let supervisor = Arc::clone(&supervisor);
            let stream: Box<dyn TransportStream> = Box::new(server_side);
            tokio::spawn(async move { supervisor.handle_client(stream).await })
        };
        let (read, mut write) = client_side.into_split();
        let mut reader = BufReader::new(read);
        let mut hello = String::new();
        reader
            .read_line(&mut hello)
            .await
            .expect("the daemon hello");

        let line = r#"{"type":"command","id":"l1","protocol":{"name":"prime-agent.daemon","version":7},"command":{"type":"list","all":true}}"#;
        let start = tokio::time::Instant::now();
        write
            .write_all(line.as_bytes())
            .await
            .expect("send the line");
        write.write_all(b"\n").await.expect("newline");
        let mut buffer = String::new();
        let response = loop {
            reader.read_line(&mut buffer).await.expect("read a frame");
            let frame = serde_json::from_str::<Value>(buffer.trim_end()).expect("the frame parses");
            if frame.get("id").and_then(Value::as_str) == Some("l1") {
                break frame;
            }
            buffer.clear();
        };
        let elapsed = start.elapsed();
        served.abort();

        assert_eq!(
            response["success"], true,
            "the wire list failed: {response}"
        );
        let rows = response["data"]["sessions"]
            .as_array()
            .cloned()
            .expect("session rows");
        let silent_row = row_for(&rows, "w-silent");
        assert_eq!(
            silent_row.get("activity").and_then(Value::as_str),
            Some("working"),
            "the silent resident serves its pushed busy summary, not the offline fallback: {silent_row}"
        );
        assert_eq!(
            silent_row.get("isStreaming").and_then(Value::as_bool),
            Some(true)
        );
        assert_eq!(
            silent_row.get("sessionName").and_then(Value::as_str),
            Some("w-silent-name")
        );
        let second_row = row_for(&rows, "w-second");
        assert_eq!(
            second_row.get("activity").and_then(Value::as_str),
            Some("idle")
        );
        assert!(
            elapsed < WEDGED_SUMMARY_BUDGET,
            "the wire list waited {elapsed:?} behind one silent resident"
        );
    }
}
