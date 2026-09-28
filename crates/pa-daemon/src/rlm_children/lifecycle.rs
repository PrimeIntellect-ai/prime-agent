//! The child-lifecycle concern: session creation (create/launch), the
//! prompt/kill/close routing, settle watching with its notices, and the
//! spawn-admission outbox types (`CreatedSessionIds`, `CreatedChild`).
use super::{
    anyhow, compact_rlm_text, create_rlm_child_terminal_notice, json, now_ms, usage, Arc,
    ChildCloseReason, ChildRecord, Context, DaemonCommand, DaemonSessionLifecycle, Duration, Map,
    Mutex, ParentIdentity, Path, PromptInput, Result, RlmChildTerminalNotice,
    SupervisorChildSessionsInner, Value, CREATE_TIMEOUT_MS, IDLE_WAIT_GRACE_MS, KILL_TIMEOUT_MS,
    NOTICE_DELIVERY_TIMEOUT_MS, PROMPT_TIMEOUT_MS, RUNTIME_METADATA_PROMPT_MAX, STATE_TIMEOUT_MS,
    WATCH_MAX_UNREACHABLE_POLLS, WATCH_POLL_INTERVAL_MS, WATCH_SETTLE_GRACE_MS,
    WATCH_WAIT_SLICE_MS,
};

/// Parsed ids of one created child session.
struct CreatedSessionIds {
    active_session_id: String,
    session_id: Option<String>,
    session_file: Option<String>,
    session_name: Option<String>,
}

pub(super) struct CreatedChild {
    pub(super) active_session_id: String,
    pub(super) session_id: Option<String>,
    pub(super) session_file: Option<String>,
    pub(super) session_name: Option<String>,
    pub(super) session_dir: String,
    pub(super) summary_rlm_depth: Option<u64>,
}

impl CreatedChild {
    fn from_summary(summary: &Value, session_dir: &Path) -> Result<Self> {
        let ids = SupervisorChildSessionsInner::created_summary_ids(summary)?;
        Ok(Self {
            active_session_id: ids.active_session_id,
            session_id: ids.session_id,
            session_file: ids.session_file,
            session_name: ids.session_name,
            session_dir: session_dir.to_string_lossy().to_string(),
            summary_rlm_depth: summary.get("rlmDepth").and_then(Value::as_u64),
        })
    }
}

/// The plain text of a custom row's content (the notice turn's model
/// prompt); `None` for non-text content shapes.
fn custom_message_text(message: &pa_types::session::CustomMessage) -> Option<String> {
    match &message.content {
        pa_types::ai::UserContent::Text(text) => Some(text.clone()),
        pa_types::ai::UserContent::Blocks(_) => None,
    }
}

impl SupervisorChildSessionsInner {
    /// Create one child session over the supervisor link (no prompt yet).
    /// `depth` is the child's recursion depth; `session_dir` holds its
    /// persisted session; `model` is the resolved `provider/id` selector.
    #[allow(clippy::too_many_arguments)]
    pub(super) async fn create_child(
        &self,
        child_id: &str,
        name: Option<&str>,
        // The spawned task's prompt, mirrored into the create runtime
        // metadata (`None` for a depth-0 resident session).
        prompt: Option<&str>,
        depth: u32,
        model: &str,
        thinking: Option<&str>,
        cwd: &str,
        session_dir: &Path,
        runtime_metadata: Option<Value>,
        identity: &ParentIdentity,
    ) -> Result<CreatedChild> {
        let mut config = json!({
            "cwd": cwd,
            "sessionDir": session_dir.to_string_lossy(),
            "rlmDepth": depth,
            "rlmMaxDepth": identity.rlm_max_depth,
        });
        if let Some((provider, id)) = model.split_once('/') {
            config["provider"] = json!(provider);
            config["model"] = json!(id);
        } else {
            config["model"] = json!(model);
        }
        if let Some(thinking) = thinking {
            config["thinking"] = json!(thinking);
        }
        if let Some(parent_file) = &identity.session_file {
            config["parentSessionPath"] = json!(parent_file);
        }
        if let Some(script) = &identity.child_script {
            config["script"] = json!(script);
            // The scripted engine rides the identity down the recursion
            // (the TS child runtime inherits the parent's sessionConfig, so
            // a harness child spawns harness grandchildren the same way).
            config["childScript"] = json!(script);
        }
        // Runtime metadata mirrors the TS subagent runtime identity; a
        // depth-0 resident session carries none (it is a plain root session).
        let runtime_metadata = runtime_metadata.map(|mut metadata| {
            if let Some(session_id) = &identity.session_id {
                metadata["parentSessionId"] = json!(session_id);
            }
            if let Some(parent_file) = &identity.session_file {
                metadata["parentSessionFile"] = json!(parent_file);
            }
            if let Some(prompt) =
                prompt.filter(|prompt| prompt.len() <= RUNTIME_METADATA_PROMPT_MAX)
            {
                metadata["prompt"] = json!(prompt);
            }
            // The resolved model rides the metadata so the supervisor's
            // display entry carries it for passive hydration.
            if let Some((provider, model_id)) = model.split_once('/') {
                metadata["model"] = json!({ "provider": provider, "modelId": model_id });
            }
            metadata
        });
        let create = DaemonCommand::Create {
            id: None,
            session_path: None,
            continue_recent: None,
            no_session: None,
            name: name.map(str::to_string),
            config: Some(config),
            // RLM children never report telemetry (the depth-0 gate in the
            // session engine installs nothing); the worker's own opt-out
            // stays process-level.
            telemetry_disabled: None,
            runtime_metadata,
            lifecycle: Some(DaemonSessionLifecycle::Resident),
            env: None,
            launch_env: None,
            rest: Map::default(),
        };
        let summary = self
            .command(&create, CREATE_TIMEOUT_MS)
            .await
            .with_context(|| format!("spawn RLM child session {child_id}"))?;
        let created = CreatedChild::from_summary(&summary, session_dir)?;
        Ok(created)
    }

    /// Create and promptly admit one child's task (the depth-0 resident
    /// session path: the prompt is part of the awaited admission).
    #[allow(clippy::too_many_arguments)]
    pub(super) async fn launch_child(
        &self,
        child_id: &str,
        name: Option<&str>,
        prompt: &str,
        depth: u32,
        model: &str,
        thinking: Option<&str>,
        cwd: &str,
        session_dir: &Path,
        runtime_metadata: Option<Value>,
        identity: &ParentIdentity,
    ) -> Result<CreatedChild> {
        let created = self
            .create_child(
                child_id,
                name,
                None,
                depth,
                model,
                thinking,
                cwd,
                session_dir,
                runtime_metadata,
                identity,
            )
            .await?;
        // A failed prompt tears the just-created session down (TS kills the
        // created session in the create-path catch block).
        if let Err(error) = self.prompt_child(&created.active_session_id, prompt).await {
            let _ = self
                .kill_child(&created.active_session_id, ChildCloseReason::Killed)
                .await;
            return Err(error);
        }
        Ok(created)
    }

    /// Parse a created-session summary into its ids (TS `createRlmRootSession`
    /// reads `activeSessionId`/`sessionId`/`sessionFile`/`sessionName`).
    fn created_summary_ids(summary: &Value) -> Result<CreatedSessionIds> {
        let active_session_id = summary
            .get("activeSessionId")
            .or_else(|| summary.get("id"))
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
            .ok_or_else(|| anyhow!("supervisor returned a session summary without an id"))?;
        Ok(CreatedSessionIds {
            active_session_id: active_session_id.to_string(),
            session_id: summary
                .get("sessionId")
                .and_then(Value::as_str)
                .map(str::to_string),
            session_file: summary
                .get("sessionFile")
                .and_then(Value::as_str)
                .map(str::to_string),
            session_name: summary
                .get("sessionName")
                .and_then(Value::as_str)
                .map(str::to_string),
        })
    }

    pub(super) async fn prompt_child(&self, active_session_id: &str, prompt: &str) -> Result<()> {
        let command = DaemonCommand::Prompt {
            id: None,
            active_session_id: active_session_id.to_string(),
            message: prompt.to_string(),
            input: PromptInput {
                content: None,
                images: None,
                streaming_behavior: None,
                queue_if_busy: None,
                expand_prompt_templates: None,
                source: Some(json!("rpc")),
                agent_message_id: None,
                custom_message: None,
                queue_key: None,
                prefix_messages: None,
                admission_id: None,
                rlm_notice_nonce: None,
            },
            rest: Map::default(),
        };
        self.command(&command, PROMPT_TIMEOUT_MS)
            .await
            .with_context(|| format!("prompt RLM child session {active_session_id}"))?;
        Ok(())
    }

    pub(super) async fn kill_child(
        &self,
        active_session_id: &str,
        reason: ChildCloseReason,
    ) -> Result<()> {
        let mut rest = serde_json::Map::new();
        if let Some(marker) = reason.wire_marker() {
            rest.insert("rlmCloseReason".to_string(), json!(marker));
        }
        let command = DaemonCommand::Kill {
            id: None,
            active_session_id: active_session_id.to_string(),
            rest,
        };
        self.command(&command, KILL_TIMEOUT_MS)
            .await
            .with_context(|| format!("kill RLM child session {active_session_id}"))?;
        Ok(())
    }

    /// Whether the child worker still has work in flight (streaming or
    /// queued). `Err` means the child cannot be reached right now.
    pub(super) async fn child_busy(&self, active_session_id: &str) -> Result<bool> {
        let command = DaemonCommand::GetState {
            id: None,
            active_session_id: active_session_id.to_string(),
            rest: Map::default(),
        };
        let state = self.command(&command, STATE_TIMEOUT_MS).await?;
        Ok(state
            .get("isStreaming")
            .and_then(Value::as_bool)
            .unwrap_or(false)
            || state
                .get("sessionActions")
                .and_then(|actions| actions.get("queuedCount"))
                .and_then(Value::as_u64)
                .unwrap_or(0)
                > 0)
    }

    /// The child's final answer text, compacted for the roster preview.
    async fn child_answer(&self, active_session_id: &str) -> Result<Option<String>> {
        let command = DaemonCommand::GetLastAssistantText {
            id: None,
            active_session_id: active_session_id.to_string(),
            rest: Map::default(),
        };
        let answer = self.command(&command, STATE_TIMEOUT_MS).await?;
        Ok(answer
            .get("text")
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())
            .map(compact_rlm_text))
    }

    /// Best-effort bounded wait for one child to go idle. The wait is a
    /// snapshot helper, not a gate: its timeout is not an error, and the
    /// caller re-reads the child's state afterwards (TS collect: "a
    /// timeout returns current snapshots, never an error").
    pub(super) async fn wait_for_child(&self, active_session_id: &str, budget: Duration) {
        if budget.is_zero() {
            return;
        }
        let command = DaemonCommand::WaitForIdle {
            id: None,
            active_session_id: active_session_id.to_string(),
            rest: Map::default(),
        };
        let _ = self
            .command(&command, budget.as_millis() as u64 + IDLE_WAIT_GRACE_MS)
            .await;
    }

    /// Refresh one record against its worker: settle a child whose worker
    /// ran out of work and capture its answer once. An unreachable child
    /// keeps its last known state (the supervisor may be restarting).
    pub(super) async fn refresh_record(&self, record: &Arc<Mutex<ChildRecord>>) {
        {
            let record = record.lock().await;
            if !record.prompt_admitted {
                return;
            }
        }
        let active_session_id = record.lock().await.active_session_id.clone();
        let busy = self.child_busy(&active_session_id).await;
        if !matches!(busy, Ok(false)) {
            return;
        }
        // Capture the answer before taking the record lock (the capture is
        // a link round trip).
        let answer = self.child_answer(&active_session_id).await.ok().flatten();
        let mut record = record.lock().await;
        if record.settled_status.is_none() {
            record.settled_status = Some("done");
            // A settled preview is never overwritten with a later miss, but
            // a `None` capture (the settle raced the admission-to-run
            // hand-off) recovers on a later refresh.
            if !record.answer_captured || record.answer_preview.is_none() {
                record.answer_preview = answer;
                record.answer_captured = true;
            }
        }
    }

    /// Watch one admitted child until its run settles, then deliver the
    /// parent's terminal notice when the child never replied (TS
    /// `deliverTerminalMessageToParent` on the detached run task). The
    /// watcher owns no registry state: it stops as soon as the record is
    /// removed (deleted children carry their own cancelled notice).
    pub(super) async fn watch_child_settle(&self, record: &Arc<Mutex<ChildRecord>>) {
        let mut unreachable_polls: u32 = 0;
        loop {
            // The parent's session closed with this child running (a
            // replacement teardown or a session close): the child dies with
            // the parent (TS `closeChildSessions`) and no notice is owed to
            // the torn-down session - the watch ends without polling the
            // killed child.
            if record.lock().await.closed_by_parent {
                return;
            }
            // Slice-top usage flush: rows of turns that completed since the
            // last slice land here (TS flushes pending usage at each child
            // `agent_end`; the slice cadence bounds crash loss to one
            // slice, the TS staleness window's role).
            self.emit_child_usage(record).await;
            let active_session_id = record.lock().await.active_session_id.clone();
            // One bounded idle-wait slice: a slice that times out while the
            // child still runs re-slices; the returned slice means the child
            // drained its queue.
            self.wait_for_child(
                &active_session_id,
                Duration::from_millis(WATCH_WAIT_SLICE_MS),
            )
            .await;
            self.refresh_record(record).await;
            let settled = record.lock().await.settled_status.is_some();
            if settled {
                // Stability re-check: a prompt admitted to an idle worker
                // can read idle once between the admission and the turn
                // pop (the queue snapshot and the busy flag change under
                // different locks on the far side of a socket). A short
                // grace closes that window; a child that went busy again
                // (a queued continuation) keeps watching.
                tokio::time::sleep(Duration::from_millis(WATCH_SETTLE_GRACE_MS)).await;
                if !matches!(self.child_busy(&active_session_id).await, Ok(false)) {
                    record.lock().await.settled_status = None;
                    continue;
                }
                self.refresh_record(record).await;
                // The run's final rows are attributed before the terminal
                // notice rides the parent's follow-up route (TS: the run
                // task's `finally` flushes pending usage at settlement).
                self.emit_child_usage(record).await;
                self.deliver_settle_notice(record).await;
                // A settled child releases an owed goal continuation (TS
                // `_maybeResumeGoalContinuationAfterRlmWork` at the child
                // settle sites).
                self.fire_settle_hook();
                return;
            }
            // Still running (a timed-out slice or a re-queued continuation):
            // re-check liveness so a dead worker cannot spin the watch.
            let busy = self.child_busy(&active_session_id).await;
            if busy.is_ok() {
                unreachable_polls = 0;
            } else {
                unreachable_polls += 1;
                if unreachable_polls >= WATCH_MAX_UNREACHABLE_POLLS {
                    {
                        let mut state = record.lock().await;
                        if state.closed_by_parent || state.notice_delivered {
                            return;
                        }
                        state.settled_status = Some("error");
                        state.error = Some("Child worker unreachable".to_string());
                    }
                    // A dead child keeps whatever rows its file already
                    // holds; capture them before the terminal notice.
                    self.emit_child_usage(record).await;
                    self.deliver_settle_notice(record).await;
                    self.fire_settle_hook();
                    return;
                }
            }
            tokio::time::sleep(Duration::from_millis(WATCH_POLL_INTERVAL_MS)).await;
        }
    }

    /// Deliver the no-reply terminal notice for a settled child that never
    /// sent an agent message to the parent. Exactly-once: the record's
    /// notice claim collapses the races between the watcher, a natural
    /// settle during `delete_subagent`, and the delete path itself.
    async fn deliver_settle_notice(&self, record: &Arc<Mutex<ChildRecord>>) {
        let notice = {
            let mut record = record.lock().await;
            if record.notice_delivered || record.replied_since_task {
                return;
            }
            record.notice_delivered = true;
            RlmChildTerminalNotice::CompletedWithoutReply {
                child_id: record.rlm_child_id.clone(),
                session_name: record.session_name.clone(),
                last_assistant_text_preview: record.answer_preview.clone(),
            }
        };
        self.deliver_terminal_notice(&notice).await;
    }

    /// Deliver one terminal notice into the parent session: the notice rides
    /// the supervisor's `follow_up` route as an injected custom turn (the
    /// row renders in the parent transcript and the turn runs on the
    /// notice content, the TS `followUp` notice action). The reserved
    /// custom kinds are daemon provenance, so the command carries the
    /// one-shot notice capability minted in this same worker process
    /// (`child_status_notices`): the parent's queue admission accepts a
    /// reserved-kind row exclusively with a live mint, and answers
    /// anything a caller sends — with or without a guessed nonce —
    /// loudly instead.
    pub(super) async fn deliver_terminal_notice(&self, notice: &RlmChildTerminalNotice) {
        let message = create_rlm_child_terminal_notice(notice, now_ms());
        let Some(content) = custom_message_text(&message) else {
            eprintln!("pa-daemon: RLM child notice carried no text content");
            return;
        };
        let wire = serde_json::to_value(pa_types::session::AgentMessage::Custom(message))
            .unwrap_or(Value::Null);
        let nonce = crate::child_status_notices::mint();
        let command = DaemonCommand::FollowUp {
            id: None,
            active_session_id: self.parent_active_session_id.clone(),
            message: content,
            input: PromptInput {
                content: None,
                images: None,
                streaming_behavior: None,
                queue_if_busy: None,
                expand_prompt_templates: None,
                source: None,
                agent_message_id: None,
                custom_message: Some(wire),
                queue_key: None,
                prefix_messages: None,
                admission_id: None,
                rlm_notice_nonce: Some(nonce),
            },
            rest: Map::default(),
        };
        if let Err(error) = self.command(&command, NOTICE_DELIVERY_TIMEOUT_MS).await {
            eprintln!(
                "pa-daemon: RLM child terminal notice was not delivered to the parent session: {error:#}"
            );
        }
    }
}
