//! The saved-session surfaces: the `list`/`list_saved_sessions`/`create`
//! handlers, the stale-id binding and rebind seam, and the saved-row
//! builders.
use super::*;

impl Supervisor {
    /// Record one session binding (the stale-id rebind table). A supersede
    /// (a new worker taking over a session file another id was bound to)
    /// notifies the clients still attached to the superseded id through the
    /// `session_binding` event, so they re-attach to the session's current
    /// id and keep receiving its events.
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
                let _ = self.events.send((
                    ClientRouting::AttachedSession {
                        active_session_id: previous,
                    },
                    std::sync::Arc::new(event),
                ));
            }
        }
    }

    /// Retarget one connection at a session's current resident after its
    /// selector was superseded (the stale-active-id rebind seam shared by
    /// the generic route and the admission route). The connection keeps
    /// exactly its prior attached-ness under the current id, and a
    /// previously-attached client is told where it now points through a
    /// `session_binding` frame routed to the id it now holds - the
    /// supersede-time notice raced the attach roster, so this one cannot
    /// be dropped. A Detach never reaches the rebind: the seam answers it
    /// supervisor-side (the stale worker is gone, and the replacement's
    /// attach must not be dropped). Returns the current id the routed
    /// frame must carry.
    pub(crate) async fn rebind_connection(
        &self,
        selector: &str,
        resident: &Arc<ResidentWorker>,
        attached: &Arc<std::sync::Mutex<Vec<String>>>,
    ) -> String {
        let current = resident.worker_id.clone();
        self.log_line(&format!(
            "rebinding stale session id {selector} -> {current}"
        ));
        self.note_daemon_event("session_rebound", None);
        let was_attached = {
            let mut attached = attached.lock().unwrap();
            let was = attached.iter().any(|id| id == selector);
            if was {
                attached.retain(|id| id != selector);
                if !attached.iter().any(|id| id == &current) {
                    attached.push(current.clone());
                }
            }
            was
        };
        if was_attached {
            let (session_id, session_file) = {
                let descriptor = resident.descriptor.lock().await;
                (
                    descriptor.root_session_id.clone(),
                    descriptor.session_file.clone(),
                )
            };
            let _ = self.events.send((
                ClientRouting::AttachedSession {
                    active_session_id: current.clone(),
                },
                std::sync::Arc::new(json!({
                    "type": "session_binding",
                    "previousActiveSessionId": selector,
                    "activeSessionId": current,
                    "sessionId": session_id,
                    "sessionFile": session_file,
                })),
            ));
        }
        current
    }

    /// The current resident a superseded selector rebinds to (the
    /// stale-id rebind seam): the binding table maps the selector to its
    /// session's durable identity, the registry's live roster holds the
    /// resident that identity currently belongs to. `None` keeps the
    /// unknown-selector failure - only a binding whose session has a live
    /// resident rebinds.
    pub(crate) async fn binding_target(&self, selector: &str) -> Option<Arc<ResidentWorker>> {
        let binding = self.session_bindings.binding_for(selector)?;
        // A binding without a session id identifies no durable session:
        // its create never completed, and whatever later owns the file
        // path is a different session (or none at all) - rebinding into
        // it is the foreign-session hazard, not a recovery.
        let binding_session_id = binding.session_id.as_deref()?.to_string();
        let session_file = binding.session_file.as_deref()?.to_string();
        let resident = self.registry.find_by_session_file(&session_file).await?;
        // The resident must BE the binding's session, not merely hold its
        // file: a reused path must not let one session's stale ids
        // rebind into the different session that now owns the path - the
        // durable id is the identity the rebind follows.
        let resident_session = resident.descriptor.lock().await.root_session_id.clone();
        if resident_session.as_deref() != Some(binding_session_id.as_str()) {
            return None;
        }
        // Only a connected resident rebinds: a worker mid-teardown or one
        // left by a failed launch would answer `Session worker is not
        // connected` instead of the unknown-session failure the client can
        // act on.
        if resident.cmd_tx.lock().await.is_none() {
            return None;
        }
        // Only a session-ready resident rebinds: a replacement's command
        // channel exists before its create replay finishes, so a command
        // routed mid-replay would bounce off the worker's require-created
        // gate instead of waiting out the replacement. `None` keeps the
        // unknown-session failure - the client's own retry (the TUI
        // re-attaches by the durable session id) rides the
        // replacement-aware route and lands once the replay answers.
        if !resident.route_state().session_ready {
            return None;
        }
        Some(resident)
    }

    /// `list_saved_sessions` (port of `handleSavedSessionList`): stream
    /// `session_list_item`/`session_list_progress` events, then a final
    /// response with the full saved-session rows.
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
        // The catalog streams WHILE the scan runs (TS
        // `listSessionsFromDir`'s per-file `onSession`/`onProgress`: the
        // client's rows appear through the scan instead of after it). The
        // frames ride the SAME per-connection channel the final response
        // later travels, so the stream stays strictly ordered ahead of its
        // own response; the fold runs on the blocking pool, so a grown
        // store never head-of-lines a runtime worker (the #2723 class).
        let stream_rows = stream.clone();
        let scan_command_id = command_id.to_string();
        let scan_active_session_id = active_session_id.as_ref().cloned();
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
                // A failed send is the connection loop's death notice (its
                // receiver is gone): the remaining folds serve nobody, so
                // the callback stops the scan (the response travels the
                // same dead channel and drops with it). The scan runs on
                // the blocking pool, so it must never wait on client I/O:
                // a FULL queue skips the PROGRESS frame first and retries
                // the row (the row is the data; the frame is a UI hint),
                // and a still-full queue skips the row too — the terminal
                // response carries the authoritative rows regardless,
                // and the fold still has to visit every file for the data
                // itself.
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
        // The current-cwd scope keeps only the session's own rows in the
        // terminal array (the stream above already skipped the others'
        // frames): the response is the authoritative catalog.
        if scope_current {
            infos.retain(|info| info.cwd == cwd);
        }
        // The saved catalog scan never visits session-artifacts, where RLM
        // children persist: merge the passive ledger walk so a passivated
        // descendant stays catalog-visible (TS
        // `withPassiveRlmDescendantInfos`; a broken ledger degrades to the
        // saved rows alone, it never fails the catalog).
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
        // The passive ledger children stream too (TS
        // `withPassiveRlmDescendantInfos`'s `onSession`): items only, no
        // progress - the saved phase above owns the progress counts.
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
        // Every row - scanned or passive-merged - carries its tombstoned
        // descendants' spend (TS `withPassiveRlmDescendantInfos`'s
        // deleted-usage half): one bucket read per list, attached by
        // canonical parent path so the agents-view recursive rollup bills
        // deleted subagents to the parent that spent them. A broken ledger
        // degrades to bare rows, exactly like the passive merge above.
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
        // The scan's completion marker: the per-file progress counts
        // DIRECTORY entries, while the rows only stream for valid files,
        // so the last per-row progress can land short of the total when
        // an invalid file yields no row (TS's onProgress counts every
        // file, valid or not, so its stream always reaches its total).
        // One final frame names the scan's end exactly; a consumer
        // waiting for `loaded == total` observes completion.
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
        // The streamed rows already reached the client through the scan
        // (and the passive merge above); the terminal response is the
        // authoritative array (the scan never re-orders after streaming).
        let mut lines = Vec::new();
        let sessions: Vec<Value> = infos.iter().map(saved_session_row).collect();
        lines.push(response_line(&response_success(
            Some(command_id),
            "list_saved_sessions",
            Some(json!({ "sessions": sessions })),
        )));
        // Telemetry: how many served rows carry a usage summary — the
        // agents-view spend columns' data (a count only, never session
        // payload).
        let rows_with_usage = infos.iter().filter(|info| info.usage.is_some()).count();
        if let Some(client) = &*self.telemetry.lock().unwrap() {
            pa_core::session_engine::telemetry::track_saved_sessions_usage(client, rows_with_usage);
        }
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
            // TS `buildSessionList` order: saved rows (resident ones
            // replaced in place by their live summary), then passive
            // ledger children, then resident-only rows.
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
                        // Resident roots carry their active session id
                        // so passive children of a resident parent
                        // report parentActiveSessionId.
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
            // TS `buildSessionList` order: saved rows, passive children,
            // then resident-only rows.
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
        // The per-file open single-flight (TS `openingWorkers`): one
        // create at a time per session file. A concurrent open waits
        // behind this one and then reuses the worker it launched — both
        // reaching the launch would race the runtime session lease.
        let opening_guard = self.opening_guard(command).await?;
        // TS `createOrReuseWorker`'s reuse seam: an open of a session file
        // a live worker already serves answers the LIVE binding (the
        // client attaches next) instead of launching a second worker over
        // the same file — a launch the runtime session lease would reject
        // with `Session is already active`. `None` keeps the launch path.
        // The seam runs BEFORE the name check (TS reserves names only on
        // the fresh-launch path): a named open of an already-active
        // session reuses it — its own name is not a conflict.
        if let Some(summary) = self
            .reuse_live_worker_for_create(command, &client_id)
            .await?
        {
            return Ok(summary);
        }
        if let DaemonCommand::Create {
            name: Some(name), ..
        } = command
        {
            self.assert_session_name_available(name).await?;
        }
        // TS daemon-supervisor.ts: only a `client_owned`-lifecycle create
        // is client-owned (`ownerClientId = command.lifecycle ===
        // "client_owned" ? clientId : undefined`); unspecified and
        // `Resident` lifecycles are unowned. Every RLM child spawn
        // declares `Resident`, so a spawned child never inherits the
        // spawning client's ownership: passivation deletes an owned
        // worker's rows, and a stopped child under a surviving root must
        // passivate instead (the walk e2e asserts the passive row
        // survives the kill). A `None`-lifecycle create being owner-
        // marked would hide its live session from every other client
        // (`assertWorkerAccessibleToClient`), so it stays unowned too.
        let create_lifecycle = match command {
            DaemonCommand::Create { lifecycle, .. } => *lifecycle,
            _ => None,
        };
        let owner_client_id = match create_lifecycle {
            Some(DaemonSessionLifecycle::ClientOwned) => Some(client_id),
            _ => None,
        };
        let (resident, create_summary) = self.launch_worker(command, owner_client_id).await?;
        // The launch registered its worker (the registry insert precedes
        // the spawn). The single-flight stays held through the spawn
        // admission below: an admission failure tears the resident down,
        // and a concurrent open that had just reused it would hold a
        // summary for a worker that no longer exists.
        // Spawn admission is the moment the supervisor knows the child's
        // edge firsthand. The ledger is the only topology store, so the
        // append's outcome is load-bearing: admission fails if the spawn
        // record cannot be made durable (a swallowed failure would admit a
        // child that listing and hydration can never find after
        // passivation). Admission reads the CREATE response: it is
        // authoritative (launch_worker rejects a sessioned create without
        // a durable non-empty session file). A fresh get_state here races
        // worker replacement (a rebooting worker mid-replay answers
        // without the session file yet) and would tear down a healthy
        // child on a stale miss.
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
        // The response still matches attach/list rows exactly: prefer a
        // fresh get_state, but a degraded one falls back to the
        // authoritative create summary instead of failing the spawn (the
        // session is durable at this point; the child is healthy).
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
        // The new session joins the agent roster immediately (subscribers
        // see the roster_update before their next list) — as an
        // authoritative pull write, so its embedded counter raises the
        // stale-delta watermark for the resident.
        self.write_roster_summary_for_resident(&resident, &summary)
            .await;
        // The new root's passive family renders immediately from the
        // ledger edges - no transcript read on the event path - then one
        // bounded background hydration fills each newly seeded row's
        // durable display fields (cwd, model, thinking level) and
        // publishes them as one update. A fresh session has no family;
        // the guards skip every row another surface already seeded. The
        // root is the CREATE response's session file (the authoritative
        // durable path, exactly what admission reads): a get_state that
        // answers mid-replay without its session file must not skip a
        // resume's family, and a live get_state file that differs is
        // still the same session.
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
        // TS `inactiveLifecycleForSession`: archived/crash markers stay
        // archived; everything else is live once a message exists, draft
        // otherwise.
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
    });
    // The persisted thinking level rides every saved-session summary row
    // (the durable `thinking_level_change` entry): the agents-view Model
    // column renders "model:level" for sessions without a live worker,
    // top-level and subagent alike.
    if let Some(level) = &info.thinking_level {
        if let Some(object) = row.as_object_mut() {
            object.insert("thinkingLevel".to_string(), json!(level));
        }
    }
    // TS `summaryForInactiveSession` publishes the scan's own-usage
    // summary: the agents-view roster record reads it before the saved
    // catalog row's (own cost `daemon.usage ?? saved.usage`). The child's
    // own row carries the child spend, so rollups never double count.
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

/// Saved-session row (port of `serializeSavedSessionInfo`).
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
    // TS `serializeSavedSessionInfo` publishes the scan's own-usage
    // summary: the agents-view spend columns and the archived-row
    // keep-condition read `saved.usage.cost`. The child's own row
    // carries the child spend, so rollups never double count.
    if let Some(usage) = &info.usage {
        object.insert("usage".to_string(), json!(usage));
    }
    // TS #2506 `serializeSavedSessionInfo`'s optional
    // `deletedDescendantUsage`: the recursive spend of ledger-tombstoned
    // descendants (the listing arm attaches it from the spawn ledger's
    // bucket). The agents-view recursive cost rollup adds it to this
    // row's own cost — the deleted child keeps no row anywhere, its
    // spend bills here exactly once.
    if let Some(deleted) = &info.deleted_descendant_usage {
        object.insert("deletedDescendantUsage".to_string(), json!(deleted));
    }
    // The persisted thinking level rides the catalog row too: the TUI merges
    // it into live summaries that lack one (the same enrichment as `model`).
    if let Some(level) = &info.thinking_level {
        object.insert("thinkingLevel".to_string(), json!(level));
    }
    row
}
