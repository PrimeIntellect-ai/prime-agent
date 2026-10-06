//! The saved-session surfaces: the `list`/`list_saved_sessions`/`create`
//! handlers, the stale-id binding and rebind seam, and the saved-row
//! builders.
use super::{
    anyhow, bail, json, list_sessions, mpsc, name_unavailable_error, paths, reservation_key,
    response_failure, response_line, response_success, subscribers, Arc, DaemonCommand,
    DaemonResponse, DaemonSessionLifecycle, NameScope, Outbound, Path, PathBuf, ResidentWorker,
    Result, RouteAdmission, Supervisor, Value, ROUTE_TIMEOUT_MS,
};

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
    /// then a final response with the full saved-session rows.
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
        let scan = tokio::task::spawn_blocking(move || {
            let mut file_total = 0usize;
            let infos = crate::session_scan::list_sessions_with(&dir, |index, total, info| {
                file_total = total;
                if scope_current && info.cwd != scan_cwd {
                    // The row is out of scope, but the scan itself goes on.
                    return true;
                }
                let row = saved_session_row(info);
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
            (infos, file_total)
        });
        let (mut infos, file_total) = match scan.await {
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
            let row = saved_session_row(info);
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
        let sessions: Vec<Value> = infos.iter().map(saved_session_row).collect();
        lines.push(response_line(&response_success(
            Some(command_id),
            "list_saved_sessions",
            Some(json!({ "sessions": sessions })),
        )));
        // Telemetry: how many served rows carry a usage summary (a count only,
        // never session payload).
        let rows_with_usage = infos.iter().filter(|info| info.usage.is_some()).count();
        self.note_saved_sessions_listed(rows_with_usage);
        lines
    }

    pub(crate) async fn handle_list(
        self: &Arc<Self>,
        command_id: String,
        type_name: String,
        all: Option<bool>,
        cwd: Option<String>,
        session_dir: Option<String>,
        include_remote_mesh: bool,
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
        let mut summaries: Vec<Value> = if let Some(true) = all {
            // TS `buildSessionList` order: saved rows (resident ones replaced in place by
            // their live summary), then passive children, then resident-only rows.
            let mut infos = list_sessions(&dir);
            if let Some(cwd) = cwd {
                infos.retain(|info| info.cwd == cwd);
            }
            let residents = self.registry.list().await;
            let mut resident_by_file: Vec<ResidentRoot> = Vec::new();
            for resident in &residents {
                let descriptor = resident.descriptor.lock().await;
                if let Some(session_file) = &descriptor.session_file {
                    resident_by_file.push(ResidentRoot {
                        session_file: crate::lease::canonical_session_path(Path::new(session_file)),
                        resident: Arc::clone(resident),
                        // Resident roots carry their active session id so passive children of a
                        // resident parent report parentActiveSessionId.
                        active_session_id: Some(descriptor.root_active_session_id.clone()),
                    });
                }
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
                        summaries.push(self.worker_summary(&root.resident).await);
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
                resident_only.push(self.worker_summary(&root.resident).await);
            }
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
            match crate::rlm_roster::walk_passive_rlm_children(&ledger, &roots) {
                Ok(children) => {
                    for child in &children {
                        summaries.push(crate::rlm_roster::passive_child_summary(child));
                    }
                }
                Err(error) => {
                    let message = format!("Could not walk passive RLM children: {error:#}");
                    self.log_line(&message);
                    return response_failure(Some(&command_id), &type_name, &message, None);
                }
            }

            summaries.append(&mut resident_only);
            summaries
        } else {
            // Live residents of this supervisor.
            let mut summaries = Vec::new();
            for resident in self.registry.list().await {
                summaries.push(self.worker_summary(&resident).await);
            }
            summaries
        };
        // Remote rows are a view opt-in (TS #2516): `sessions` stays a
        // local-residency response by default - stale-daemon replacement
        // and update-restart recovery read it and must never mistake a
        // tailnet peer for a local session. An opting-in caller still
        // drives the mesh's on-demand refresh, and remote rows carry no
        // session file, so they never collide with the file-based merge
        // paths above.
        if include_remote_mesh {
            self.refresh_remote_mesh(crate::supervisor_roster::REMOTE_MESH_LIST_REFRESH_WAIT)
                .await;
            summaries.extend(
                self.remote_mesh
                    .as_ref()
                    .map(crate::remote_mesh::RemoteAgentMeshState::session_summaries)
                    .unwrap_or_default(),
            );
        }
        response_success(
            Some(&command_id),
            &type_name,
            Some(json!({ "sessions": summaries })),
        )
    }

    /// One resident's live summary (`get_state`), with the recovering-row
    /// fallback for an unreachable worker.
    async fn worker_summary(self: &Arc<Self>, resident: &Arc<ResidentWorker>) -> Value {
        let response = self
            .route_command_typed(
                resident,
                "get_state",
                json!({}),
                ROUTE_TIMEOUT_MS,
                RouteAdmission::SupervisorInternal,
            )
            .await;
        match response {
            Ok(response) if response.success => response
                .data
                .unwrap_or_else(|| offline_summary(&resident.worker_id)),
            _ => offline_summary(&resident.worker_id),
        }
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
        for resident in self.registry.list().await {
            let response = self
                .route_command_typed(
                    &resident,
                    "get_state",
                    json!({}),
                    ROUTE_TIMEOUT_MS,
                    RouteAdmission::SupervisorInternal,
                )
                .await;
            if let Ok(response) = response {
                if let Some(data) = &response.data {
                    let session_name = data
                        .get("sessionName")
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    if session_name == name {
                        return Err(anyhow!(
                            "Agent name \"{name}\" is unavailable: an agent of that name already exists at depth 0 under this parent"
                        ));
                    }
                }
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
    resident: Arc<ResidentWorker>,
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

pub(super) fn saved_session_row(info: &crate::session_store::SessionInfo) -> Value {
    let mut row = json!({
        "path": info.path.to_string_lossy(),
        "id": info.id,
        "cwd": info.cwd,
        "rlmDepth": info.rlm_depth,
        "created": info.created,
        "modified": info.modified,
        "messageCount": info.message_count,
        "firstMessage": info.first_message,
        // The scan's capped transcript corpus (TS `allMessagesText`): the
        // agents-view full-transcript search field.
        "allMessagesText": info.all_messages_text,
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
    row
}
