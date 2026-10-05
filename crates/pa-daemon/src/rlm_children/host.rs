//! The host adapter concern: the `RlmSubagentHost` wire surface
//! (`spawn`, `create_session`, `list_subagents`, `delete_subagent`,
//! `collect`) over the supervisor's child-sessions registry, with the
//! spawn-admission helpers only this surface uses.
use super::{
    assert_thinking_supported, bail, create_default_rlm_subagent_session_name,
    create_rlm_child_terminal_notice, json, now_ms, resolve_child_model, rlm_child_label,
    spawn_name_unavailable, Arc, ChildCloseReason, ChildRecord, Context, DaemonCommand, Duration,
    Instant, Mutex, Path, PathBuf, Result, RlmChildResult, RlmChildTerminalNotice,
    RlmCreateSessionHandle, RlmCreateSessionRequest, RlmDeleteSubagentResult, RlmHostFuture,
    RlmSpawnHandle, RlmSpawnRequest, RlmSubagentEntry, RlmSubagentHost, SpawnNameReservationGuard,
    SupervisorChildSessions, SupervisorChildSessionsInner, Value, KILL_TIMEOUT_MS,
};

/// Resolve the child model with the daemon `allowedModels` allowlist
/// enforced (the parent's cwd scopes the settings read), refusing a model
/// outside the allowlist loudly with the typed error and emitting the
/// `model refused` adoption event through the worker's shared client. The
/// settings read (a synchronous file lock under `with_lock`) runs on the
/// blocking pool, so a contended settings lock never stalls this async
/// spawn path's Tokio worker.
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
            // TS `_startRlmChildRun` (#2396): a requested name is reserved
            // before the first await and held until the admission settles,
            // so two parallel same-name spawns cannot both pass the
            // availability check and both register durable children. A
            // default name embeds its fresh child id and never reserves
            // (TS parity). The RAII guard owns the release: it frees the
            // name at the admission settle, on every failure path, and on
            // cancellation (a dropped host future) alike.
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
                        request.spawned_by_request_id.as_deref(),
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
            // The reservation's guard is still bound: the release runs at
            // this scope's end (a successful registration made the name
            // durable - it transfers from the pending reservation to the
            // live registry), on every earlier failure path's `?`, and on
            // cancellation of the host future itself.
            // The task prompt runs detached from the spawn admission (TS
            // `void (async () => ...)`): the handle returns at registration
            // and the child's first turn starts after the parent's own
            // continuation request is in flight. The watcher starts once
            // the prompt is admitted (it idles on a pre-prompt child).
            let watcher_this = Arc::clone(&this);
            let watcher_record = Arc::clone(&record);
            let prompt = request.prompt.clone();
            let child_active_session_id = created.active_session_id.clone();
            let child_session_file = created.session_file.clone();
            // Capture the current turn boundary before detaching: spawn
            // admission happens mid-turn, so the parent's continuation
            // request (already issued for this turn's tool result) is
            // guaranteed to reach the provider first (see
            // `wait_turn_done`).
            let turn_generation = *this.turn_done.subscribe().borrow();
            tokio::spawn(async move {
                watcher_this.wait_turn_done(turn_generation).await;
                // The parent session closed before the prompt admitted (a
                // replacement teardown or a session close between the spawn
                // and the turn boundary): the child is closed with the
                // parent, so the detached task prompt never fires.
                if watcher_record.lock().await.closed_by_parent {
                    return;
                }
                watcher_record.lock().await.prompt_admitted = true;
                if let Err(error) = watcher_this
                    .prompt_child(&child_active_session_id, &prompt, &[])
                    .await
                {
                    // The route can fail ambiguously around a worker
                    // replacement: the frame reached a dying connection and
                    // no reply came back. The child's durable session file
                    // is the record the replacement replays from, so it
                    // arbitrates the ambiguity - a prompt already in the
                    // file landed (re-sending would duplicate the first
                    // turn), a missing prompt provably never landed and one
                    // retry against the replaced worker is safe.
                    let landed =
                        session_file_carries_prompt(child_session_file.as_deref(), &prompt);
                    let retried = if landed {
                        Ok(())
                    } else {
                        watcher_this
                            .prompt_child(&child_active_session_id, &prompt, &[])
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
            // `create`: the shared sessions dir and the requested cwd
            // (TS `resolve(this._cwd, rawCwd)`), no per-child artifacts dir.
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
            // Selector errors surface unwrapped (TS parity: the
            // `No direct RLM subagent matches ...` message is the product
            // surface); only the kill below gets a delete context.
            let record = this.resolve_record(&target, "subagent").await?;
            let active_session_id = record.lock().await.active_session_id.clone();
            // Kill first: a failed kill keeps the child tracked so the caller
            // can retry; a successful kill removes it from the registry.
            // The `rlmLedgerDelete` marker tells the supervisor this kill
            // is a delete (a plain stop must not tombstone the child).
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
            // reaching the worker (a turn that completed just before the
            // kill aborted the in-flight one): the post-kill walk is the
            // LAST observation — after this the record closes and no
            // watcher reads the file again. The cursor keeps the second
            // walk free of double-billing.
            this.emit_child_usage(&record).await;
            // The final observation landed: the registration drops (TS
            // keeps a child's subscription alive only while the child
            // lives).
            this.forget_child_usage(&record).await;
            // The watcher owns an Arc to this record; deleting the roster
            // row alone cannot stop its polling loop.
            record.lock().await.closed_by_parent = true;
            let entry = {
                let record = record.lock().await;
                SupervisorChildSessions::entry(&record)
            };
            // The delete receipt promised a collectable cancelled envelope
            // (TS #2388): the tombstone keeps the child's identity behind
            // the registry so a just-deleted selector still answers
            // `rlm.collect` with its settled cancellation instead of the
            // unknown-selector error.
            {
                let record = record.lock().await;
                this.remember_deleted_child(&record);
            }
            // The deletion commits BEFORE the best-effort terminal
            // notice: the notice's supervisor delivery can ride its full
            // timeout, and a deleted child must leave the registry and the
            // cached context tree immediately, not after it.
            this.children
                .lock()
                .await
                .retain(|candidate| !Arc::ptr_eq(candidate, &record));
            // The cached context-tree rows must not outlive the child: a
            // deleted subagent leaves `/context` immediately (the
            // background refresh would otherwise resurrect it through the
            // settled-children backfill until its next walk).
            if let Some(notify) = this
                .delete_notifier
                .lock()
                .expect("delete notifier lock")
                .clone()
            {
                notify(&entry.rlm_child_id);
            }
            // A still-running child was cut short by the delete: the parent
            // session receives the cancelled terminal notice (TS
            // `completeDeletion`, reason `Deleted by parent orchestrator`).
            // The settle watcher stops silently once the record leaves the
            // registry, so the delete path owns this notice.
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
            // The deletion settles the run (TS `_finishRlmRunDeletion`,
            // the same resume site the inactive delete funnels through):
            // a parked barrier re-reads a removed record as settled.
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
            // TS #2388: a target whose delete receipt already returned
            // resolves immediately to its settled cancelled envelope —
            // the delete accepted the cancellation, so waiting for a
            // teardown that already finished (or reporting the snapshot it
            // would produce) would only mislead callers. Unknown selectors
            // keep erroring, and a live record always owns its selector
            // again (a respawn under a freed name wins before the
            // tombstone is consulted), so the deleted generation never
            // answers for a live replacement.
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
                // A settled child that is busy again runs a follow-up turn
                // (delayed messaging): re-arm usage observation — the
                // task-run watcher retired at its settle. A roster read
                // settles nothing here; the arm only observes usage.
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
            // Live entries first, the deleted generations' envelopes after
            // (TS `collectRlmChildren` result order).
            results.extend(deleted_results);
            Ok(results)
        })
    }
}

/// Whether the child's durable session file already carries the task prompt
/// as a user message. The session file is the record a worker replacement
/// replays from, so it arbitrates an ambiguous prompt-route failure: a
/// prompt in the file was durably processed by the dead worker (a re-send
/// would duplicate the first turn), a missing prompt provably never landed.
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
