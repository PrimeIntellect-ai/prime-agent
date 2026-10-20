//! The host adapter concern: the `RlmSubagentHost` wire surface
//! (`spawn`, `create_session`, `list_subagents`, `delete_subagent`,
//! `collect`, `rename`) over the supervisor's child-sessions registry,
//! with the spawn-admission helpers only this surface uses.
use super::{
    assert_thinking_supported, bail, create_default_rlm_subagent_session_name, json, now_ms,
    resolve_child_model, rlm_child_label, rlm_depth_limit_error, spawn_name_unavailable_error, Arc,
    ChildCloseReason, ChildObservationSource, ChildRecord, Context, DaemonCommand, Duration,
    Instant, Mutex, Path, PathBuf, Result, RlmChildResult, RlmCreateSessionHandle,
    RlmCreateSessionRequest, RlmDeleteSubagentResult, RlmHostFuture, RlmSpawnHandle,
    RlmSpawnRequest, RlmSubagentEntry, RlmSubagentHost, SpawnNameReservationGuard,
    SupervisorChildSessions, SupervisorChildSessionsInner, Value, KILL_TIMEOUT_MS,
    RENAME_TIMEOUT_MS,
};

/// Resolve the child model with the daemon `allowedModels` allowlist enforced, refusing loudly with
/// the typed error and the `model refused` event; the settings read runs on the blocking pool.
async fn resolve_child_model_allowlisted(
    this: &SupervisorChildSessionsInner,
    reference: Option<&str>,
    surface: &'static str,
    target: &str,
) -> Result<String> {
    let identity = this.identity.lock().expect("identity lock").clone();
    let cwd = identity.cwd.clone().unwrap_or_else(|| "/".to_string());
    let load_cwd = cwd.clone();
    let agent_dir = this.agent_dir.clone();
    let allowlist = tokio::task::spawn_blocking(move || {
        crate::model_allowlist::load(Path::new(&load_cwd), &agent_dir)
    })
    .await
    .context("the allowlist load task join failed")?;
    match resolve_child_model(
        &this.agent_dir,
        reference,
        identity.model.as_deref(),
        target,
        &allowlist,
    ) {
        Ok(model) => Ok(model),
        Err(error) => {
            if let Some(refusal) = error.downcast_ref::<pa_core::models::ModelAllowlistRefusal>() {
                this.model_refusal_telemetry.note_refused(
                    surface,
                    &refusal.selector,
                    Path::new(&cwd),
                );
            }
            Err(error)
        }
    }
}

/// The `rlm.create_session` launch env (TS `createRlmRootSession`'s
/// minimal map: `collectDaemonLaunchEnv({ PATH })` plus the provider's
/// env API-key var plus `PRIME_TEAM_ID` for prime-inference).
fn create_session_launch_env(
    model: &str,
    read_env: impl Fn(&str) -> Option<String>,
) -> std::collections::BTreeMap<String, String> {
    let mut env = std::collections::BTreeMap::new();
    // A depth-zero session uses a minimal provider environment, but must
    // retain the caller's privacy and explicit test/eval classification.
    for key in [
        "DO_NOT_TRACK",
        "PI_OFFLINE",
        "PRIME_AGENT_TELEMETRY",
        "PRIME_AGENT_TELEMETRY_ORIGIN",
    ] {
        if let Some(value) = read_env(key) {
            env.insert(key.to_string(), value);
        }
    }
    if let Some(path) = read_env("PATH") {
        env.insert("PATH".to_string(), path);
    }
    let provider = model
        .split_once('/')
        .map_or(model, |(provider, _)| provider);
    if let Some(env_key) =
        pa_ai::env_api_keys::find_env_keys(provider).and_then(|keys| keys.first().cloned())
    {
        if let Some(value) = read_env(&env_key) {
            env.insert(env_key, value);
        }
    }
    if provider == "prime-inference" {
        if let Some(team) = read_env("PRIME_TEAM_ID") {
            env.insert("PRIME_TEAM_ID".to_string(), team);
        }
    }
    env
}

impl RlmSubagentHost for SupervisorChildSessions {
    fn spawn(&self, request: RlmSpawnRequest) -> RlmHostFuture<RlmSpawnHandle> {
        let this = Arc::clone(&self.inner);
        Box::pin(async move {
            let identity = this.identity.lock().expect("identity lock").clone();
            if identity.rlm_depth >= identity.rlm_max_depth {
                bail!(rlm_depth_limit_error(
                    identity.rlm_depth,
                    identity.rlm_max_depth
                ));
            }
            let child_id = format!("sub-{}", &uuid::Uuid::new_v4().simple().to_string()[..8]);
            let name = request.name.clone().unwrap_or_else(|| {
                create_default_rlm_subagent_session_name(&request.prompt, &child_id)
            });
            // A requested name is reserved before the first await and held
            // until the admission settles, so parallel same-name spawns
            // cannot both register; a default name never reserves.
            let _reservation = request
                .name
                .is_some()
                .then(|| {
                    if !this.reserve_spawn_name(&name) {
                        return Err(spawn_name_unavailable_error(&name, identity.rlm_depth + 1));
                    }
                    Ok(SpawnNameReservationGuard {
                        inner: Arc::clone(&this),
                        name: name.clone(),
                    })
                })
                .transpose()?;
            let admission = async {
                this.assert_name_available(&name, identity.rlm_depth + 1)
                    .await?;
                let model = resolve_child_model_allowlisted(
                    &this,
                    request.model.as_deref(),
                    "spawn",
                    "subagent",
                )
                .await?;
                assert_thinking_supported(&this.agent_dir, request.thinking.as_deref(), &model)?;
                let thinking = request.thinking.as_deref().or(identity.thinking.as_deref());
                let child_dir = this.child_session_dir(&child_id, &identity)?;
                let cwd = identity.cwd.clone().unwrap_or_else(|| "/".to_string());
                let runtime_metadata = json!({
                    "kind": "subagent",
                    "rlmChildId": child_id,
                    "parentActiveSessionId": this.parent_active_session_id,
                    "rlmDepth": identity.rlm_depth + 1,
                    "createdAt": now_ms(),
                });
                let created = this
                    .create_child(
                        &child_id,
                        Some(&name),
                        Some(&request.prompt),
                        identity.rlm_depth + 1,
                        &model,
                        thinking,
                        &cwd,
                        &child_dir,
                        request.spawned_by_request_id.as_deref(),
                        Some(runtime_metadata),
                        &identity,
                        // TS runs `rlm.spawn` children in-process
                        // inside the parent worker, so they share its
                        // env; the Rust child is a separate worker
                        // process, so the spawn forwards the parent
                        // worker's env (filtered) instead.
                        Some(pa_types::daemon::launch_env::collect_process_launch_env()),
                    )
                    .await?;
                let record = ChildRecord {
                    rlm_child_id: child_id.clone(),
                    session_name: created.session_name.clone().unwrap_or_else(|| name.clone()),
                    active_session_id: created.active_session_id.clone(),
                    session_id: created.session_id.clone(),
                    session_dir: created.session_dir.clone(),
                    model: model.clone(),
                    label: rlm_child_label(&request.prompt),
                    started_at_ms: now_ms(),
                    settled_status: None,
                    settled: false,
                    answer_preview: None,
                    answer_text: None,
                    answer_captured: false,
                    replied_since_task: false,
                    progress_note: None,
                    tool_use_count: None,
                    live_observation: None,
                    direct_observation: Arc::new(Mutex::new(())),
                    notice_delivered: false,
                    prompt_admitted: false,
                    error: None,
                    closed_by_parent: false,
                    retirement_finished: false,
                    retirement_notified: false,
                    retirement_roster_emitted: false,
                    usage_registration_forgotten: false,
                    session_file: created.session_file.clone(),
                    attributed_rows: Some(0),
                    pending_usage_report: None,
                    usage_watch_live: false,
                    usage_rearm: false,
                    emit_lock: std::sync::Arc::new(tokio::sync::Mutex::new(())),
                    last_emitted_status: None,
                    rename_lock: std::sync::Arc::new(tokio::sync::Mutex::new(())),
                };
                let record = Arc::new(Mutex::new(record));
                this.children.lock().await.push(Arc::clone(&record));
                this.refresh_running().await;
                this.emit_child_update(&record).await;
                anyhow::Ok((record, created, model))
            }
            .await;
            let (record, created, model) = admission?;
            // The task prompt runs detached from the spawn admission: the
            // handle returns at registration and the child's first turn
            // starts after the parent's continuation request is in flight.
            let watcher_this = Arc::clone(&this);
            let watcher_record = Arc::clone(&record);
            // TS `spawnMessage`: the kickoff rides prompt admission as
            // the parent's `agent_message` row, so the child renders a
            // parent message and the model reads the
            // "[task from parent]" label.
            let prompt = request.prompt.as_str();
            let kickoff_content = format!("[task from parent]\n\n{prompt}");
            let kickoff_row_id = format!("spawn:{child_id}");
            let mut parent_endpoint = json!({
                "activeSessionId": this.parent_active_session_id,
            });
            if let Some(session_id) = &identity.session_id {
                parent_endpoint["sessionId"] = json!(session_id);
            }
            if let Some(name) = this
                .parent_session_name
                .lock()
                .expect("parent session name lock")
                .clone()
            {
                parent_endpoint["sessionName"] = json!(name);
            }
            let kickoff_row =
                pa_core::session_engine::agent_messaging::create_agent_session_message_row(
                    &pa_core::session_engine::agent_messaging::AgentSessionMessageRowPayload {
                        id: &kickoff_row_id,
                        prompt: &kickoff_content,
                        message: prompt,
                        from: &parent_endpoint,
                        from_relationship: Some(
                            pa_core::session_engine::agent_messaging::AgentFamilyRelationship::Parent,
                        ),
                        // TS `spawnMessage` carries no `target`.
                        target: None,
                        timestamp: now_ms(),
                    },
                );
            let child_active_session_id = created.active_session_id.clone();
            let child_session_file = created.session_file.clone();
            let child_log_id = child_id.clone();
            // Capture the current turn boundary before detaching: spawn
            // admission happens mid-turn, so the parent's continuation
            // request reaches the provider first (see `wait_turn_done`).
            let turn_generation = *this.turn_done.subscribe().borrow();
            tokio::spawn(async move {
                watcher_this.wait_turn_done(turn_generation).await;
                // The parent closed before the prompt admitted: the
                // child is closed with it, so the detached task prompt
                // never fires.
                if watcher_record.lock().await.closed_by_parent {
                    return;
                }
                watcher_record.lock().await.prompt_admitted = true;
                if let Err(error) = watcher_this
                    .prompt_child(
                        &child_active_session_id,
                        &kickoff_content,
                        Some(&kickoff_row),
                    )
                    .await
                {
                    // The route can fail ambiguously around a worker
                    // replacement. The durable session file arbitrates: a
                    // kickoff row in the file landed (re-sending would
                    // duplicate the first turn); one retry is safe.
                    let landed = session_file_carries_spawn_kickoff(
                        child_session_file.as_deref(),
                        &kickoff_row_id,
                    );
                    let retried = if landed {
                        Ok(())
                    } else {
                        watcher_this
                            .prompt_child(
                                &child_active_session_id,
                                &kickoff_content,
                                Some(&kickoff_row),
                            )
                            .await
                    };
                    if let Err(retry_error) = retried {
                        eprintln!(
                            "pa-daemon: RLM child task prompt failed for {child_log_id}: {error:#}; retry failed: {retry_error:#}"
                        );
                        let _ = watcher_this
                            .kill_child(&child_active_session_id, ChildCloseReason::Killed)
                            .await;
                        watcher_this
                            .settle_failed(
                                &watcher_record,
                                format!("{retry_error:#}"),
                                super::lifecycle::FailedArm::Prompt,
                            )
                            .await;
                        return;
                    }
                }
                watcher_this.watch_child_settle(&watcher_record).await;
            });
            Ok(RlmSpawnHandle {
                rlm_child_id: child_id,
                name,
                session_dir: created.session_dir,
                model,
            })
        })
    }

    fn create_session(
        &self,
        request: RlmCreateSessionRequest,
    ) -> RlmHostFuture<RlmCreateSessionHandle> {
        let this = Arc::clone(&self.inner);
        Box::pin(async move {
            let identity = this.identity.lock().expect("identity lock").clone();
            if identity.rlm_depth != 0 {
                bail!("rlm.create_session is available only from a depth-0 session");
            }
            let model = resolve_child_model_allowlisted(
                &this,
                request.model.as_deref(),
                "create_session",
                "top-level session",
            )
            .await?;
            assert_thinking_supported(&this.agent_dir, request.thinking.as_deref(), &model)?;
            // A depth-0 resident session is created exactly like a client
            // `create`: the shared sessions dir and the requested cwd.
            let cwd = match &request.cwd {
                Some(cwd) if Path::new(cwd).is_absolute() => PathBuf::from(cwd),
                Some(cwd) => Path::new(identity.cwd.as_deref().unwrap_or("/")).join(cwd),
                None => PathBuf::from(identity.cwd.clone().unwrap_or_else(|| "/".to_string())),
            };
            let sessions_dir = crate::paths::sessions_dir(&this.agent_dir)?;
            std::fs::create_dir_all(&sessions_dir)
                .with_context(|| format!("create sessions dir {}", sessions_dir.display()))?;
            let thinking = request.thinking.as_deref().or(identity.thinking.as_deref());
            let created = this
                .launch_child(
                    "root",
                    request.name.as_deref(),
                    &request.prompt,
                    0,
                    &model,
                    thinking,
                    &cwd.to_string_lossy(),
                    &sessions_dir,
                    None,
                    &identity,
                    // The TS minimal map for a depth-0 root (the
                    // env-key heuristic is stated in the PR).
                    Some(create_session_launch_env(&model, |key| {
                        std::env::var(key).ok()
                    })),
                )
                .await?;
            // The TS create-path summary validation: a resident depth-0
            // session must never report another depth.
            if created.summary_rlm_depth.is_some_and(|depth| depth != 0) {
                bail!("Daemon supervisor returned an invalid depth-0 session summary");
            }
            Ok(RlmCreateSessionHandle {
                active_session_id: created.active_session_id.clone(),
                session_id: created
                    .session_id
                    .clone()
                    .unwrap_or_else(|| created.active_session_id.clone()),
                name: created
                    .session_name
                    .clone()
                    .unwrap_or_else(|| created.active_session_id.clone()),
                session_file: created.session_file.unwrap_or_default(),
                model,
            })
        })
    }

    fn list_subagents(&self) -> RlmHostFuture<Vec<RlmSubagentEntry>> {
        let this = Arc::clone(&self.inner);
        Box::pin(async move {
            let records = this.children.lock().await.clone();
            // The children's live note and tool count join from the
            // supervisor's pushed roster: one in-memory read, never a busy
            // child worker round trip. A failed read keeps the last values
            // each record observed; the settle watcher owns worker refreshes.
            let request_order = this
                .observation_requests
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            if let Some(peers) = this.child_roster_rows(&records).await {
                for record in &records {
                    let (rlm_child_id, active_session_id) = {
                        let record = record.lock().await;
                        (
                            record.rlm_child_id.clone(),
                            record.active_session_id.clone(),
                        )
                    };
                    let live = peers
                        .iter()
                        .find(|row| {
                            row.get("rlmChildId").and_then(Value::as_str)
                                == Some(rlm_child_id.as_str())
                        })
                        .or_else(|| {
                            peers.iter().find(|row| {
                                row.get("activeSessionId").and_then(Value::as_str)
                                    == Some(active_session_id.as_str())
                            })
                        });
                    if let Some(live) = live {
                        this.observe_live_state(
                            record,
                            live,
                            request_order,
                            ChildObservationSource::Roster,
                        )
                        .await;
                    }
                }
            }
            let mut entries = Vec::with_capacity(records.len());
            for record in &records {
                // A roster read is a snapshot: the rows serve the records'
                // last observed state without another round trip.
                let record = record.lock().await;
                entries.push(SupervisorChildSessions::entry(&record));
            }
            Ok(entries)
        })
    }

    fn delete_subagent(&self, target: String) -> RlmHostFuture<RlmDeleteSubagentResult> {
        let this = Arc::clone(&self.inner);
        Box::pin(async move {
            if !this.replay_retired_usage(Some(&target)).await {
                bail!("RLM child usage remains owed after retirement; retry deletion");
            }
            // Selector errors surface unwrapped (the TS message is the
            // product surface); only the kill below gets a delete context.
            let record = match this.resolve_record(&target, "subagent").await {
                Ok(record) => record,
                Err(miss) => {
                    // Retirement is idempotent (the M5 class): a selector
                    // whose delete receipt already returned answers from
                    // the tombstone instead of erroring, so a re-delete of
                    // a settled child (an operator retire, the factory's
                    // cancel pass) never reports the slot as still held.
                    let matches = this
                        .deleted_children
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner)
                        .values()
                        .filter(|deleted| deleted.matches(&target))
                        .cloned()
                        .collect::<Vec<_>>();
                    match matches.len() {
                        0 => return Err(miss),
                        1 => {
                            let deleted = &matches[0];
                            return Ok(RlmDeleteSubagentResult {
                                subagent: RlmSubagentEntry {
                                    rlm_child_id: deleted.rlm_child_id.clone(),
                                    active_session_id: Some(deleted.active_session_id.clone()),
                                    session_id: deleted.session_id.clone(),
                                    session_name: deleted.session_name.clone(),
                                    session_dir: deleted.session_dir.clone(),
                                    status: deleted.status,
                                    activity: None,
                                    tool_use_count: None,
                                    duration_ms: Some(
                                        now_ms().saturating_sub(deleted.started_at_ms),
                                    ),
                                    answer_preview: deleted.answer_preview.clone(),
                                    replied_since_task: None,
                                    progress_note: None,
                                    label: None,
                                    last_activity_at: Some(deleted.started_at_ms),
                                    activity_stale_ms: None,
                                },
                                outcome: Some("deleted"),
                            });
                        }
                        _ => bail!(
                            "RLM subagent selector \"{target}\" is ambiguous in the current parent session"
                        ),
                    }
                }
            };
            let rename_lock = record.lock().await.rename_lock.clone();
            let _rename_guard = rename_lock.lock().await;
            let already_terminated = this.has_retired_usage(&record);
            let no_longer_matches = {
                let record = record.lock().await;
                (record.closed_by_parent && !already_terminated) || !record.matches(&target)
            };
            if no_longer_matches {
                bail!("No direct RLM subagent matches \"{target}\" in the current parent session");
            }
            let active_session_id = record.lock().await.active_session_id.clone();
            // Kill first: a failed kill keeps the child tracked; the
            // `rlmLedgerDelete` marker tells the supervisor this kill is a
            // delete, never a plain stop.
            let record_guard = record.lock().await;
            let command = DaemonCommand::Kill {
                id: None,
                active_session_id: active_session_id.clone(),
                rest: serde_json::Map::from_iter([
                    ("rlmLedgerDelete".to_string(), json!("user")),
                    ("rlmChildId".to_string(), json!(record_guard.rlm_child_id)),
                ]),
            };
            drop(record_guard);
            let was_running = record.lock().await.settled_status.is_none();
            // Capture before the kill: a deleted running child's durable
            // rows are its last observable spend on the parent side.
            if !already_terminated {
                this.emit_child_usage(&record).await;
                this.command(&command, KILL_TIMEOUT_MS)
                    .await
                    .with_context(|| format!("kill RLM child \"{target}\""))?;
                this.retain_retired_usage(&record, super::RetirementIntent::Delete { was_running });
                // Observe any rows that landed before the acknowledged kill.
                this.emit_child_usage(&record).await;
            }
            // The final observation landed: the registration drops.
            let usage_persisted = this.forget_child_usage(&record).await;
            this.finish_retirement(&record).await;
            let entry = {
                let record = record.lock().await;
                SupervisorChildSessions::entry(&record)
            };
            if usage_persisted {
                this.remove_retired_usage(&record);
            }
            if !usage_persisted {
                bail!("RLM child usage remains owed after retirement; retry deletion");
            }
            Ok(RlmDeleteSubagentResult {
                subagent: entry,
                outcome: Some("deleted"),
            })
        })
    }

    fn collect(&self, targets: Vec<String>, timeout_ms: u64) -> RlmHostFuture<Vec<RlmChildResult>> {
        let this = Arc::clone(&self.inner);
        Box::pin(async move {
            // Resolve targets outside the registry lock: `resolve_record`
            // takes it too, and the tokio mutex is not re-entrant.
            let mut records: Vec<Arc<Mutex<ChildRecord>>> = if targets.is_empty() {
                this.children.lock().await.clone()
            } else {
                Vec::with_capacity(targets.len())
            };
            // A target whose delete receipt already returned resolves
            // immediately to its settled cancelled envelope; unknown
            // selectors keep erroring (a respawned freed name wins first).
            let mut deleted_results: Vec<RlmChildResult> = Vec::new();
            for target in &targets {
                let record = match this.resolve_record(target, "child").await {
                    Ok(record) => record,
                    Err(miss) => {
                        let matches = this
                            .deleted_children
                            .lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner)
                            .values()
                            .filter(|deleted| deleted.matches(target))
                            .cloned()
                            .collect::<Vec<_>>();
                        match matches.len() {
                            0 => return Err(miss),
                            1 => deleted_results
                                .push(SupervisorChildSessions::deleted_collect_result(&matches[0])),
                            _ => bail!(
                                "RLM child selector \"{target}\" is ambiguous in the current parent session"
                            ),
                        }
                        continue;
                    }
                };
                records.push(record);
            }
            let deadline = Instant::now() + Duration::from_millis(timeout_ms);
            let mut results = Vec::with_capacity(records.len());
            for record in &records {
                this.refresh_record(record).await;
                // A settled child that is busy again runs a follow-up turn:
                // re-arm usage observation (the task-run watcher retired at
                // its settle).
                if record.lock().await.settled_status.is_some() {
                    let active_session_id = record.lock().await.active_session_id.clone();
                    if matches!(this.child_busy(&active_session_id).await, Ok(true)) {
                        SupervisorChildSessionsInner::arm_usage_watch(&this, record).await;
                    }
                }
                let still_running = record.lock().await.settled_status.is_none();
                if still_running {
                    // Wait inside the shared budget, then re-read the child:
                    // a timeout yields the current snapshot, never an error.
                    let remaining = deadline.saturating_duration_since(Instant::now());
                    let active_session_id = record.lock().await.active_session_id.clone();
                    this.wait_for_child(&active_session_id, remaining).await;
                    this.refresh_record(record).await;
                }
                let result = {
                    let record = record.lock().await;
                    SupervisorChildSessions::collect_result(&record)
                };
                results.push(result);
            }
            // Live entries first, the deleted generations' envelopes after.
            results.extend(deleted_results);
            Ok(results)
        })
    }

    fn rename(&self, name: String, session_id: Option<String>) -> RlmHostFuture<String> {
        let this = Arc::clone(&self.inner);
        Box::pin(async move {
            // Resolve the target: the caller's own session (an absent
            // session id, its live active id, or its durable session id),
            // or one direct child by rlm child id, active id, or durable
            // session id ONLY — a child NAME never selects a rename
            // target (TS `renameAgentFamilySession`).
            let identity = this.identity.lock().expect("identity lock").clone();
            let self_target = match &session_id {
                None => true,
                Some(target) => {
                    target == &this.parent_active_session_id
                        || identity.session_id.as_deref() == Some(target.as_str())
                }
            };
            let (active_session_id, record) = if self_target {
                (this.parent_active_session_id.clone(), None)
            } else {
                let target = session_id.clone().unwrap_or_default();
                let mut by_ids = None;
                let mut by_name = false;
                {
                    let children = this.children.lock().await;
                    for candidate in children.iter() {
                        let record = candidate.lock().await;
                        if record.matches_id(&target) {
                            by_ids = Some(Arc::clone(candidate));
                            break;
                        }
                        if record.session_name == target {
                            by_name = true;
                        }
                    }
                }
                match by_ids {
                    Some(record) => {
                        let active_session_id = record.lock().await.active_session_id.clone();
                        (active_session_id, Some(record))
                    }
                    None if by_name => bail!(
                        "rlm.rename session_id \"{target}\" must be the full session id or a child handle, not a session name or id suffix"
                    ),
                    None => bail!(
                        "rlm.rename can only rename the current session or one of its direct children"
                    ),
                }
            };
            // Serialize the daemon command and parent-side record update
            // against another rename or delete of this child.
            let rename_lock = if let Some(record) = &record {
                Some(record.lock().await.rename_lock.clone())
            } else {
                None
            };
            let _rename_guard = if let Some(lock) = &rename_lock {
                Some(lock.lock().await)
            } else {
                None
            };
            if let Some(record) = &record {
                if record.lock().await.closed_by_parent {
                    bail!(
                        "rlm.rename can only rename the current session or one of its direct children"
                    );
                }
            }
            // The rename itself is daemon-owned: the supervisor's live
            // rename route reserves the name, asserts sibling uniqueness
            // across the family, and appends the child's RLM ledger
            // rename. `renamedBy: parent` marks the parent-directed
            // rename so the renamed session's transcript notice names it.
            // The child may be passivated — or a prior wake may have
            // re-keyed its roster row past the record's spawn-time id —
            // so the rename rides the same durable-selector wake retry
            // the child prompts use (the record keeps the spawn-time
            // routing id; only its durable session id still names a
            // passivated child).
            let renamed_by = record.as_ref().map(|_| {
                pa_core::session_engine::agent_messaging::AgentFamilyRelationship::Parent
                    .as_str()
                    .to_string()
            });
            let make_command = |selector: &str| DaemonCommand::Rename {
                id: None,
                active_session_id: selector.to_string(),
                name: name.clone(),
                renamed_by: renamed_by.clone(),
                rest: serde_json::Map::default(),
            };
            this.command_with_durable_wake(
                make_command,
                &active_session_id,
                RENAME_TIMEOUT_MS,
                &format!("rename session \"{active_session_id}\""),
            )
            .await?;
            // A parent-directed rename updates the parent-side record so
            // the roster row, collect/delete selectors, and the parent's
            // name-availability check all stop matching the old name.
            if let Some(record) = record {
                record.lock().await.session_name = name.clone();
            }
            Ok(name)
        })
    }
}

/// Whether the child's durable session file already carries the spawn
/// kickoff row (`agent_message` custom row with `details.id` =
/// `spawn:<child id>`). The session file is the record a worker
/// replacement replays from, so it arbitrates an ambiguous prompt-route
/// failure: a row in the file was durably processed by the dead worker (a
/// re-send would duplicate the first turn), a missing row provably never
/// landed.
fn session_file_carries_spawn_kickoff(session_file: Option<&str>, spawn_row_id: &str) -> bool {
    let Some(path) = session_file.filter(|path| !path.is_empty()) else {
        return false;
    };
    let Ok(content) = std::fs::read_to_string(path) else {
        return false;
    };
    content
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .any(|entry| {
            entry.get("type").and_then(Value::as_str) == Some("custom_message")
                && entry.get("customType").and_then(Value::as_str)
                    == Some(pa_core::session_engine::agent_messaging::AGENT_MESSAGE_CUSTOM_TYPE)
                && entry.pointer("/details/id").and_then(Value::as_str) == Some(spawn_row_id)
        })
}

#[cfg(test)]
mod tests {
    use super::create_session_launch_env;
    use std::collections::BTreeMap;

    #[test]
    fn depth_zero_children_preserve_telemetry_controls_in_the_minimal_environment() {
        for origin in ["test", "eval", "internal"] {
            let expected = BTreeMap::from([
                ("PATH".to_string(), "/usr/bin".to_string()),
                ("DO_NOT_TRACK".to_string(), "1".to_string()),
                ("PI_OFFLINE".to_string(), "true".to_string()),
                ("PRIME_AGENT_TELEMETRY".to_string(), "1".to_string()),
                (
                    "PRIME_AGENT_TELEMETRY_ORIGIN".to_string(),
                    origin.to_string(),
                ),
            ]);
            let mut parent = expected.clone();
            parent.insert("UNRELATED_SECRET".to_string(), "not forwarded".to_string());
            assert_eq!(
                create_session_launch_env("custom/custom", |key| parent.get(key).cloned()),
                expected
            );
        }
    }
}
