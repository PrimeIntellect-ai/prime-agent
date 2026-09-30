//! The host adapter concern: the `RlmSubagentHost` wire surface (`spawn`, `create_session`,
//! `list_subagents`, `delete_subagent`, `collect`) over the supervisor's child-sessions registry.
use super::{
    assert_thinking_supported, bail, create_default_rlm_subagent_session_name,
    create_rlm_child_terminal_notice, json, now_ms, resolve_child_model, rlm_child_label,
    spawn_name_unavailable, Arc, ChildCloseReason, ChildRecord, Context, DaemonCommand, Duration,
    Instant, Mutex, Path, PathBuf, Result, RlmChildResult, RlmChildTerminalNotice,
    RlmCreateSessionHandle, RlmCreateSessionRequest, RlmDeleteSubagentResult, RlmHostFuture,
    RlmSpawnHandle, RlmSpawnRequest, RlmSubagentEntry, RlmSubagentHost, SpawnNameReservationGuard,
    SupervisorChildSessions, SupervisorChildSessionsInner, Value, KILL_TIMEOUT_MS,
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

impl RlmSubagentHost for SupervisorChildSessions {
    fn spawn(&self, request: RlmSpawnRequest) -> RlmHostFuture<RlmSpawnHandle> {
        let this = Arc::clone(&self.inner);
        Box::pin(async move {
            let identity = this.identity.lock().expect("identity lock").clone();
            if identity.rlm_depth >= identity.rlm_max_depth {
                bail!(
                    "RLM recursion depth limit reached (RLM_DEPTH={}, RLM_MAX_DEPTH={})",
                    identity.rlm_depth,
                    identity.rlm_max_depth
                );
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
                        return Err(spawn_name_unavailable(&name, identity.rlm_depth + 1));
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
                        Some(runtime_metadata),
                        &identity,
                    )
                    .await?;
                let record = ChildRecord {
                    rlm_child_id: child_id.clone(),
                    session_name: created.session_name.clone().unwrap_or_else(|| name.clone()),
                    active_session_id: created.active_session_id.clone(),
                    session_id: created.session_id.clone(),
                    session_dir: created.session_dir.clone(),
                    label: rlm_child_label(&request.prompt),
                    started_at_ms: now_ms(),
                    settled_status: None,
                    settled: false,
                    answer_preview: None,
                    answer_captured: false,
                    replied_since_task: false,
                    notice_delivered: false,
                    prompt_admitted: false,
                    error: None,
                    closed_by_parent: false,
                    session_file: created.session_file.clone(),
                    attributed_rows: Some(0),
                    usage_watch_live: false,
                    usage_rearm: false,
                    emit_lock: std::sync::Arc::new(tokio::sync::Mutex::new(())),
                };
                let record = Arc::new(Mutex::new(record));
                this.children.lock().await.push(Arc::clone(&record));
                this.refresh_running().await;
                anyhow::Ok((record, created, model))
            }
            .await;
            let (record, created, model) = admission?;
            // The task prompt runs detached from the spawn admission: the
            // handle returns at registration and the child's first turn
            // starts after the parent's continuation request is in flight.
            let watcher_this = Arc::clone(&this);
            let watcher_record = Arc::clone(&record);
            let prompt = request.prompt.clone();
            let child_active_session_id = created.active_session_id.clone();
            let child_session_file = created.session_file.clone();
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
                    .prompt_child(&child_active_session_id, &prompt)
                    .await
                {
                    // The route can fail ambiguously around a worker
                    // replacement. The durable session file arbitrates: a
                    // prompt in the file landed (re-sending would duplicate
                    // the first turn); one retry is safe.
                    let landed =
                        session_file_carries_prompt(child_session_file.as_deref(), &prompt);
                    let retried = if landed {
                        Ok(())
                    } else {
                        watcher_this
                            .prompt_child(&child_active_session_id, &prompt)
                            .await
                    };
                    if let Err(retry_error) = retried {
                        eprintln!(
                            "pa-daemon: RLM child task prompt failed for {child_active_session_id}: {error:#}; retry failed: {retry_error:#}"
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
            let mut entries = Vec::with_capacity(records.len());
            for record in &records {
                // The settle watcher owns worker refreshes. A roster read is a
                // snapshot and must not queue behind a long supervisor request.
                let record = record.lock().await;
                entries.push(SupervisorChildSessions::entry(&record));
            }
            Ok(entries)
        })
    }

    fn delete_subagent(&self, target: String) -> RlmHostFuture<RlmDeleteSubagentResult> {
        let this = Arc::clone(&self.inner);
        Box::pin(async move {
            // Selector errors surface unwrapped (the TS message is the
            // product surface); only the kill below gets a delete context.
            let record = this.resolve_record(&target, "subagent").await?;
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
            this.emit_child_usage(&record).await;
            this.command(&command, KILL_TIMEOUT_MS)
                .await
                .with_context(|| format!("kill RLM child \"{target}\""))?;
            // Rows can land between the pre-kill capture and the kill
            // reaching the worker: the post-kill walk is the LAST observation
            // (the cursor keeps it free of double-billing).
            this.emit_child_usage(&record).await;
            // The final observation landed: the registration drops.
            this.forget_child_usage(&record).await;
            // The watcher owns an Arc to this record; deleting the roster
            // row alone cannot stop its polling loop.
            record.lock().await.closed_by_parent = true;
            let entry = {
                let record = record.lock().await;
                SupervisorChildSessions::entry(&record)
            };
            // The tombstone keeps the identity behind the registry so a
            // just-deleted selector still answers `collect`.
            {
                let record = record.lock().await;
                this.remember_deleted_child(&record);
            }
            // The deletion commits BEFORE the best-effort terminal notice:
            // a deleted child leaves the registry and the cached context
            // tree immediately.
            this.children
                .lock()
                .await
                .retain(|candidate| !Arc::ptr_eq(candidate, &record));
            // A deleted subagent leaves `/context` immediately (the
            // background refresh would otherwise resurrect it).
            if let Some(notify) = this
                .delete_notifier
                .lock()
                .expect("delete notifier lock")
                .clone()
            {
                notify(&entry.rlm_child_id);
            }
            // A still-running child was cut short by the delete: the
            // parent receives the cancelled terminal notice.
            if was_running {
                let notice = {
                    let mut record = record.lock().await;
                    let claimed = !record.notice_delivered;
                    record.notice_delivered = true;
                    claimed.then(|| RlmChildTerminalNotice::Cancelled {
                        child_id: record.rlm_child_id.clone(),
                        session_name: record.session_name.clone(),
                        reason: Some("Deleted by parent orchestrator".to_string()),
                    })
                };
                if let Some(notice) = notice {
                    this.deliver_terminal_notice(create_rlm_child_terminal_notice(
                        &notice,
                        now_ms(),
                    ))
                    .await;
                }
            }
            // The deletion settles the run: a parked barrier re-reads a removed
            // record as settled.
            this.fire_settle_hook(&record).await;
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
                            1 => deleted_results.push(
                                SupervisorChildSessions::deleted_collect_result(
                                    &matches[0],
                                ),
                            ),
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
}

/// Whether the child's durable session file already carries the task
/// prompt (the record a worker replacement replays from arbitrates).
fn session_file_carries_prompt(session_file: Option<&str>, prompt: &str) -> bool {
    let Some(path) = session_file.filter(|path| !path.is_empty()) else {
        return false;
    };
    let Ok(content) = std::fs::read_to_string(path) else {
        return false;
    };
    content
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter(|entry| {
            entry.get("type").and_then(Value::as_str) == Some("message")
                && entry.pointer("/message/role").and_then(Value::as_str) == Some("user")
        })
        .any(|entry| match entry.pointer("/message/content") {
            Some(Value::String(text)) => text.contains(prompt),
            Some(Value::Array(blocks)) => blocks.iter().any(|block| {
                block
                    .get("text")
                    .and_then(Value::as_str)
                    .is_some_and(|text| text.contains(prompt))
            }),
            _ => false,
        })
}
