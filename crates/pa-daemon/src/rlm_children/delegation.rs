//! One-shot image-turn delegation: the child lifecycle for the daemon's
//! image-model routing (`settings.imageModel`) when the session model
//! cannot see images. The engine's dispatch seam
//! (`agent_engine::image_delegation`) resolves the image model and owns
//! the turn; this module owns the child machinery: create one child on the
//! resolved image model, prompt it IMMEDIATELY with the turn's actual
//! image bytes riding the prompt wire (`PromptInput.images`), wait for its
//! run to settle (abort-aware, reusing the settle watcher's slice and
//! unreachable-poll constants - no new timeout bound), and capture the
//! full answer text (uncapped; the roster preview compacts it).
use super::{
    create_default_rlm_subagent_session_name, json, now_ms, rlm_child_label, Arc, ChildCloseReason,
    ChildRecord, Duration, Mutex, SupervisorChildSessions, SupervisorChildSessionsInner,
    WATCH_MAX_UNREACHABLE_POLLS, WATCH_POLL_INTERVAL_MS, WATCH_SETTLE_GRACE_MS,
};
use crate::rlm_child_model::compact_rlm_text;

/// One image-turn delegation request: the child runs `model` (the resolved
/// `settings.imageModel` selector with the thinking level the resolver
/// already clamped to its vocabulary) and its whole task is `prompt` (the
/// delegation instruction built from the user's original text) plus
/// `images` (the delivered image blocks of the turn).
pub(crate) struct ImageDelegationRequest {
    pub prompt: String,
    /// Resolved image-model selector (`provider/id`).
    pub model: String,
    /// The resolver-clamped thinking level for the image model.
    pub thinking: Option<String>,
    /// The turn's delivered images (primary plus batch rows), riding the
    /// prompt wire to the child natively.
    pub images: Vec<pa_agent::types::ImageContent>,
}

/// The delegation's terminal outcome for one image-carrying turn.
pub(crate) enum ImageDelegationOutcome {
    /// The child settled with its answer text.
    Answered {
        child_id: String,
        session_name: String,
        answer: String,
    },
    /// The child failed (create, prompt, run, or answer read): the turn
    /// fails loudly with the error — never a placeholder, never a
    /// fallback to serving the text-only session model the images.
    Failed { error: String },
}

impl SupervisorChildSessions {
    /// Delegate one image-carrying turn to a child running the resolved
    /// image model. See the module docs for the lifecycle contract.
    pub(crate) async fn delegate_image_turn(
        &self,
        request: ImageDelegationRequest,
        aborted: &dyn Fn() -> bool,
    ) -> ImageDelegationOutcome {
        self.inner.delegate_image_turn(request, aborted).await
    }
}

impl SupervisorChildSessionsInner {
    /// The child's final answer text, uncapped (the delegation carries the
    /// full description into the parent turn; only the roster preview
    /// compacts it).
    async fn child_answer_text(&self, active_session_id: &str) -> anyhow::Result<Option<String>> {
        let command = pa_types::daemon::DaemonCommand::GetLastAssistantText {
            id: None,
            active_session_id: active_session_id.to_string(),
            rest: serde_json::Map::default(),
        };
        let answer = self.command(&command, super::STATE_TIMEOUT_MS).await?;
        Ok(answer
            .get("text")
            .and_then(serde_json::Value::as_str)
            .filter(|text| !text.is_empty())
            .map(str::to_string))
    }

    /// Settle a failed delegation child: the record takes the terminal
    /// error status, its usage flushes once, and the settle funnel fires
    /// (the roster and the quiescence predicate see a settled child).
    async fn fail_delegation_child(&self, record: &Arc<Mutex<ChildRecord>>, error: String) {
        {
            let mut record = record.lock().await;
            if record.settled_status.is_none() {
                record.settled_status = Some("error");
                record.error = Some(error.clone());
            }
        }
        self.emit_child_usage(record).await;
        self.fire_settle_hook(record).await;
    }

    async fn delegate_image_turn(
        &self,
        request: ImageDelegationRequest,
        aborted: &dyn Fn() -> bool,
    ) -> ImageDelegationOutcome {
        let identity = self.identity.lock().expect("identity lock").clone();
        if identity.rlm_depth >= identity.rlm_max_depth {
            // No silent model swap and no image downgrade: the user's
            // product expectation is the child, and a depth-capped
            // session cannot host one.
            return ImageDelegationOutcome::Failed {
                error: format!(
                    "delegate the image turn to an image-model child: this session is at its recursion depth cap ({}/{})",
                    identity.rlm_depth, identity.rlm_max_depth
                ),
            };
        }
        let child_id = format!("sub-{}", &uuid::Uuid::new_v4().simple().to_string()[..8]);
        // A default name embeds the fresh child id and never needs a
        // reservation (TS parity with the spawn path's default names).
        let name = create_default_rlm_subagent_session_name(&request.prompt, &child_id);
        let child_dir = match self.child_session_dir(&child_id, &identity) {
            Ok(dir) => dir,
            Err(error) => {
                return ImageDelegationOutcome::Failed {
                    error: format!("create the image-model child session dir: {error:#}"),
                }
            }
        };
        let cwd = identity.cwd.clone().unwrap_or_else(|| "/".to_string());
        let runtime_metadata = json!({
            "kind": "subagent",
            "rlmChildId": child_id,
            "parentActiveSessionId": self.parent_active_session_id,
            "rlmDepth": identity.rlm_depth + 1,
            "createdAt": now_ms(),
        });
        let created = match self
            .create_child(
                &child_id,
                Some(&name),
                Some(&request.prompt),
                identity.rlm_depth + 1,
                &request.model,
                request.thinking.as_deref(),
                &cwd,
                &child_dir,
                Some(runtime_metadata),
                &identity,
            )
            .await
        {
            Ok(created) => created,
            Err(error) => {
                return ImageDelegationOutcome::Failed {
                    error: format!("create the image-model child session: {error:#}"),
                }
            }
        };
        // The roster row: the delegation lands the child's answer in the
        // parent session itself (the description row ahead of the turn's
        // model run), so the no-reply terminal notice is never owed and no
        // settle watcher runs - this flow owns the wait. The prompt admits
        // immediately below (no turn-boundary deferral).
        let record = Arc::new(Mutex::new(ChildRecord {
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
            replied_since_task: true,
            notice_delivered: false,
            prompt_admitted: true,
            error: None,
            closed_by_parent: false,
            session_file: created.session_file.clone(),
            attributed_rows: 0,
            usage_watch_live: false,
            usage_rearm: false,
            emit_lock: std::sync::Arc::new(tokio::sync::Mutex::new(())),
        }));
        self.children.lock().await.push(Arc::clone(&record));
        self.refresh_running().await;
        if let Err(error) = self
            .prompt_child(&created.active_session_id, &request.prompt, &request.images)
            .await
        {
            let _ = self
                .kill_child(&created.active_session_id, ChildCloseReason::Killed)
                .await;
            self.fail_delegation_child(&record, format!("{error:#}"))
                .await;
            return ImageDelegationOutcome::Failed {
                error: format!("prompt the image-model child: {error:#}"),
            };
        }
        // The settle wait mirrors `watch_child_settle`: one bounded
        // idle-wait slice per loop, a stability re-check before the settle
        // decision, per-slice usage flushes, and the unreachable-poll bound
        // for a dead child worker. The total wait is unbounded - the bound
        // is the child's own lifecycle, exactly as a provider turn blocks
        // on its request - with the parent turn's abort consulted between
        // slices.
        let mut unreachable_polls: u32 = 0;
        loop {
            if record.lock().await.closed_by_parent {
                // The parent closed mid-delegation: no answer is owed to a
                // closing session, and the record must not leave the
                // quiescence predicate stuck on an unsettled row.
                self.fail_delegation_child(
                    &record,
                    "the parent session closed during image delegation".to_string(),
                )
                .await;
                return ImageDelegationOutcome::Failed {
                    error: "the parent session closed during image delegation".to_string(),
                };
            }
            self.emit_child_usage(&record).await;
            if aborted() {
                let active_session_id = record.lock().await.active_session_id.clone();
                let _ = self
                    .kill_child(&active_session_id, ChildCloseReason::Killed)
                    .await;
                self.fail_delegation_child(&record, "aborted by the user".to_string())
                    .await;
                return ImageDelegationOutcome::Failed {
                    error: "the image delegation was aborted".to_string(),
                };
            }
            let active_session_id = record.lock().await.active_session_id.clone();
            // A short existing poll slice keeps the parent abort responsive
            // while the child runs; the normal settle watcher can use its
            // longer slice because it does not gate a live parent turn.
            self.wait_for_child(
                &active_session_id,
                Duration::from_millis(WATCH_POLL_INTERVAL_MS),
            )
            .await;
            match self.child_busy(&active_session_id).await {
                Ok(false) => {
                    // Stability re-check: an idle read between the
                    // admission and the turn pop is not a settle (the same
                    // grace the watcher closes).
                    tokio::time::sleep(Duration::from_millis(WATCH_SETTLE_GRACE_MS)).await;
                    if !matches!(self.child_busy(&active_session_id).await, Ok(false)) {
                        continue;
                    }
                    let answer = self.child_answer_text(&active_session_id).await;
                    match answer {
                        Ok(Some(answer)) => {
                            {
                                let mut record = record.lock().await;
                                record.settled_status = Some("done");
                                if !record.answer_captured || record.answer_preview.is_none() {
                                    record.answer_preview = Some(compact_rlm_text(&answer));
                                    record.answer_captured = true;
                                }
                            }
                            self.emit_child_usage(&record).await;
                            self.fire_settle_hook(&record).await;
                            return ImageDelegationOutcome::Answered {
                                child_id,
                                session_name: created.session_name.unwrap_or(name),
                                answer,
                            };
                        }
                        // A settled child without an answer text, or an
                        // answer read that failed: the error is preserved
                        // (never swallowed) and the record keeps the
                        // error status it settles with.
                        Ok(None) => {
                            self.fail_delegation_child(
                                &record,
                                "the image-model child produced no answer".to_string(),
                            )
                            .await;
                            return ImageDelegationOutcome::Failed {
                                error: "the image-model child produced no answer".to_string(),
                            };
                        }
                        Err(error) => {
                            let error = format!("read the image-model child's answer: {error:#}");
                            self.fail_delegation_child(&record, error.clone()).await;
                            return ImageDelegationOutcome::Failed { error };
                        }
                    }
                }
                Ok(true) => {
                    unreachable_polls = 0;
                }
                Err(_) => {
                    unreachable_polls += 1;
                    if unreachable_polls >= WATCH_MAX_UNREACHABLE_POLLS {
                        self.fail_delegation_child(&record, "Child worker unreachable".to_string())
                            .await;
                        return ImageDelegationOutcome::Failed {
                            error: "the image-model child worker became unreachable".to_string(),
                        };
                    }
                    tokio::time::sleep(Duration::from_millis(WATCH_POLL_INTERVAL_MS)).await;
                }
            }
        }
    }
}
