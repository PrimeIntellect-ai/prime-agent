//! The input handlers behind dispatch: prompt delivery, queue
//! operations, and agent-message delivery.
use super::*;

use serde_json::Value;

use crate::protocol::{response_failure, DaemonResponse};

impl Worker {
    pub(crate) async fn handle_prompt(&self, payload: &Value, wait: bool) -> DaemonResponse {
        if let Err(response) = self.require_created("prompt") {
            return response;
        }
        let message = payload
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if message.is_empty() {
            return response_failure(None, "prompt", "Prompt cannot be empty", None);
        }
        let streaming_behavior = payload.get("streamingBehavior").and_then(Value::as_str);
        let custom_message = match parse_custom_message(payload.get("customMessage")) {
            Ok(custom_message) => custom_message,
            Err(error) => return response_failure(None, "prompt", &error, None),
        };
        // The reserved child-status kinds are daemon provenance (the
        // queue-fold anti-spoof): the notice injection rides the
        // follow-up route only, so a prompt row claiming one is always a
        // spoof — answered loudly, never parked.
        if let Some(row) = custom_message.as_ref() {
            if crate::child_status_notices::is_reserved_child_status_custom_type(row) {
                return response_failure(
                    None,
                    "prompt",
                    &crate::child_status_notices::reserved_intake_error(),
                    None,
                );
            }
        }
        let images = parse_prompt_images(payload);
        // TS daemon prompts map `resumeIfIdle` to
        // `command.streamingBehavior !== undefined`: while the queued-input
        // suspension is set (post `abort`/manual `compact`), a plain prompt
        // on an idle session is rejected with the TS admission error and a
        // prompt carrying `streamingBehavior` resumes the suspension
        // (TS `_prompt`'s `_resumeSessionInputAdmission()` +
        // `_assertSessionActionAdmissionAvailable()` pair).
        {
            let mut core = self.core.lock().unwrap();
            if core.queued_input_suspended && !core.busy {
                if streaming_behavior.is_none() {
                    drop(core);
                    return response_failure(
                        None,
                        if wait { "prompt_and_wait" } else { "prompt" },
                        QUEUED_INPUT_SUSPENDED,
                        None,
                    );
                }
                core.queued_input_suspended = false;
            }
        }
        // The prompt-admission bookkeeping (wave b9): a prompt carrying an
        // admission id registers it worker-side; the queued item carries
        // it so the turn runner commits the admission when its turn starts.
        let admission_id = payload
            .get("admissionId")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
            .map(str::to_string);
        if let Some(admission_id) = &admission_id {
            self.register_prompt_admission(admission_id);
        }
        let (done_tx, done_rx) = oneshot::channel();
        let done = if wait { Some(done_tx) } else { None };
        let (snapshot, queued_behind_work) = {
            let mut core = self.core.lock().unwrap();
            // An idle session runs the prompt immediately: the lane is the
            // work hand-off, not a queue, so the projection did not change
            // (TS prompt admission with queueIfBusy=false never queues).
            let queued_behind_work = core.busy;
            let lane = match streaming_behavior {
                Some("steer") => Lane::Steering,
                // Plain prompts admitted while busy drain when the run goes
                // idle, like `queueIfBusy` prompt admission; an idle
                // session's prompt IS the next run, so it takes the
                // steering lane - otherwise a steering delivery that
                // arrives in the same window would jump the prompt's turn
                // (the runner drains steering first).
                Some(_) | None => {
                    if core.busy {
                        Lane::FollowUp
                    } else {
                        Lane::Steering
                    }
                }
            };
            // This RPC command is human-origin only for a plain user row.
            // Caller-supplied custom rows never gain human priority.
            let item = QueuedItem {
                priority: if custom_message.is_some() {
                    QueuePriority::Background
                } else {
                    QueuePriority::Human
                },
                preview: None,
                message: message.to_string(),
                custom_message,
                agent_message: None,
                queue_key: None,
                admission_id: admission_id.clone(),
                images: images.clone(),
                done,
                queue_visible: queued_behind_work,
                policy: if queued_behind_work {
                    TurnPolicy::Queued
                } else {
                    TurnPolicy::Direct
                },
                forced_batch: false,
            };
            match lane {
                Lane::Steering => enqueue_priority(&mut core.steering, item),
                Lane::FollowUp => enqueue_priority(&mut core.follow_up, item),
            }
            let snapshot = self.snapshot_locked(&core);
            (snapshot, queued_behind_work)
        };
        // The admission checkpoint (TS `prompt_accepted`, busy=true): the
        // admitted prompt is undelivered live work until its turn
        // settles, and the lane snapshot rides the same locked read.
        self.checkpoint_queue(QueueCheckpoint::Admitted {
            operation: "prompt_accepted",
        });
        if queued_behind_work {
            let _ = self.emit_action_update(&snapshot);
        }
        self.work_notify.notify_one();
        if !wait {
            return response_success(None, "prompt", None);
        }
        match done_rx.await {
            Ok(settle) => match settle.wire_error() {
                None => response_success(None, "prompt_and_wait", None),
                Some(error) => response_failure(None, "prompt_and_wait", &error, None),
            },
            Err(_) => response_failure(None, "prompt_and_wait", "Prompt did not complete", None),
        }
    }

    pub(crate) fn handle_queue(&self, payload: &Value, lane: Lane) -> DaemonResponse {
        if let Err(response) = self.require_created(lane.as_str()) {
            return response;
        }
        // TS daemon `steer`/`follow_up` pass `resumeIfIdle: true`, and an
        // admitted turn with `wake: "immediate"` resumes the suspension:
        // these commands are resume sites.
        self.resume_queued_input();
        let message = payload
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let custom_message = match parse_custom_message(payload.get("customMessage")) {
            Ok(custom_message) => custom_message,
            Err(error) => return response_failure(None, lane.as_str(), &error, None),
        };
        // The reserved child-status kinds are daemon provenance, not
        // client data (the queue-fold anti-spoof): a caller-supplied row
        // claiming one is answered loudly — it never parks, so the strip's
        // typed classification only ever sees daemon-authentic rows. The
        // daemon's own notice injection rides this same command with the
        // one-shot capability it minted in this process
        // (`child_status_notices`), the only thing the admission accepts.
        if let Some(row) = custom_message.as_ref() {
            if crate::child_status_notices::is_reserved_child_status_custom_type(row) {
                let minted = crate::child_status_notices::consume(
                    payload.get("rlmNoticeNonce").and_then(Value::as_str),
                );
                if !minted {
                    return response_failure(
                        None,
                        lane.as_str(),
                        &crate::child_status_notices::reserved_intake_error(),
                        None,
                    );
                }
            }
        }
        let mut core = self.core.lock().unwrap();
        let images = parse_prompt_images(payload);
        let item = QueuedItem {
            priority: if custom_message.is_some() {
                QueuePriority::Background
            } else {
                QueuePriority::Human
            },
            preview: None,
            message: message.to_string(),
            custom_message,
            agent_message: None,
            queue_key: None,
            admission_id: None,
            images,
            done: None,
            queue_visible: true,
            policy: TurnPolicy::Queued,
            forced_batch: false,
        };
        match lane {
            Lane::Steering => enqueue_priority(&mut core.steering, item),
            Lane::FollowUp => enqueue_priority(&mut core.follow_up, item),
        }
        let snapshot = self.snapshot_locked(&core);
        drop(core);
        // The queue-write checkpoint (busy=true): an undelivered lane is
        // live work. The operation names are TS's journal strings
        // (`steer_queued`/`follow_up_queued`), not this port's command
        // names, so the journals stay comparable record-for-record.
        let queued_operation = match lane {
            Lane::Steering => "steer_queued",
            Lane::FollowUp => "follow_up_queued",
        };
        self.checkpoint_queue(QueueCheckpoint::Admitted {
            operation: queued_operation,
        });
        let _ = self.emit_action_update(&snapshot);
        self.work_notify.notify_one();
        let command = if lane == Lane::Steering {
            "steer"
        } else {
            "follow_up"
        };
        response_success(None, command, Some(json!({ "queued": true })))
    }

    /// Agent-to-agent message delivery, routed by the supervisor's
    /// `send_message` arm: render the `[agent-message from ...]` prompt and
    /// queue it on the requested lane, carrying the `agent_message`
    /// custom row on the queued item (TS `acceptAgentSessionMessage` ->
    /// `acceptAgentMessagePrompt` with `customMessage`): the turn renders
    /// the collapsed agent-message card while the model still runs on the
    /// rendered prompt. Answers with the delivery receipt
    /// (`createAgentSessionMessageReceipt` shape): `queued` when a turn is
    /// running (`queueIfBusy` semantics), `delivered` when the prompt
    /// becomes the next run.
    pub(crate) fn handle_worker_deliver_message(&self, payload: &Value) -> DaemonResponse {
        if let Err(response) = self.require_created("worker_deliver_message") {
            return response;
        }
        let message = payload
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if let Err(error) =
            pa_core::session_engine::agent_messaging::normalize_agent_session_message(message)
        {
            return response_failure(None, "worker_deliver_message", &error.to_string(), None);
        }
        // The paused gate (TS `sendAgentSessionMessage` refuses with the
        // same error while `agent_messages_pause` holds the flag).
        if let Err(response) = self.refuse_delivery_if_paused() {
            return response;
        }
        // TS `acceptAgentMessagePrompt` runs with `resumeIfIdle: false`: on
        // a suspended idle session the delivery is rejected with the same
        // admission error as a plain prompt, and only the busy carve-out
        // (`_isBusyForSessionInput`) queues it parked.
        {
            let core = self.core.lock().unwrap();
            if core.queued_input_suspended && !core.busy && !core.compacting {
                drop(core);
                return response_failure(
                    None,
                    "worker_deliver_message",
                    QUEUED_INPUT_SUSPENDED,
                    None,
                );
            }
        }
        let sender = payload.get("sender").cloned().unwrap_or(Value::Null);
        // A delivery from one of this session's RLM children counts as the
        // child's reply: the settle watcher withholds the no-reply notice.
        if let Some(child) = sender
            .get("activeSessionId")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
        {
            self.engine.mark_child_reply(child);
        }
        // Sender label precedence (TS `createAgentSessionMessagePrompt`):
        // session name, session id, active session id, client id.
        let sender_name = ["sessionName", "sessionId", "activeSessionId", "clientId"]
            .iter()
            .find_map(|key| sender.get(*key).and_then(Value::as_str))
            .unwrap_or("unknown")
            .to_string();
        // The delivery's relationship label derives from the sender's
        // durable parent edge, never from the sender's runtime kind alone:
        // a subagent spawned by a DIFFERENT parent is not this session's
        // child, and its messages must not render as one. The core lock is
        // scoped to the read (a std MutexGuard never rides an await).
        let from_relationship = {
            let core = self
                .core
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            sender_is_child_of(&sender, &core).then_some(AgentFamilyRelationship::Child)
        };
        let prompt = pa_core::session_engine::agent_messaging::create_agent_session_message_prompt(
            &AgentMessagePromptPayload {
                message: message.to_string(),
                sender_name,
                from_relationship,
            },
        );
        let lane = if payload.get("deliveryMode").and_then(Value::as_str) == Some("follow_up") {
            Lane::FollowUp
        } else {
            Lane::Steering
        };
        let (id, queued, snapshot, target) = {
            let mut core = self.core.lock().unwrap();
            let pending = core.steering.len() + core.follow_up.len();
            if let Err(error) =
                pa_core::session_engine::agent_messaging::assert_agent_message_queue_capacity(
                    pending,
                    DEFAULT_AGENT_MESSAGE_MAX_PENDING_PER_SESSION,
                )
            {
                drop(core);
                return response_failure(None, "worker_deliver_message", &error.to_string(), None);
            }
            let id = pa_core::session_engine::agent_messaging::create_agent_session_message_id();
            let queued = core.busy;
            let summary = self.summary_locked(&core);
            // The receiving session's endpoint (TS
            // `createAgentSessionMessageEndpoint`): the receipt's `target`
            // and the delivered row's `details.target` share the one shape.
            let mut target = json!({
                "activeSessionId": summary.active_session_id.clone().unwrap_or_default(),
                "sessionId": summary.session_id,
                "runtimeKind": summary
                    .runtime_kind
                    .clone()
                    .unwrap_or_else(|| "top-level".to_string()),
            });
            if let Some(name) = summary.session_name.filter(|name| !name.is_empty()) {
                target["sessionName"] = json!(name);
            }
            // The receiving side's custom row (TS
            // `acceptAgentSessionMessage` -> `createAgentSessionMessage`,
            // riding `acceptAgentMessagePrompt`'s `customMessage`): the
            // queued turn carries the `agent_message` row so the
            // transcript renders the collapsed card instead of a plain
            // user row, while the row's `content` IS the rendered prompt -
            // the model context stays byte-identical to the
            // plain-prompt delivery.
            let custom_message =
                pa_core::session_engine::agent_messaging::create_agent_session_message_row(
                    &pa_core::session_engine::agent_messaging::AgentSessionMessageRowPayload {
                        id: &id,
                        prompt: &prompt,
                        message,
                        from: &sender,
                        from_relationship,
                        target: &target,
                        timestamp: crate::util::now_ms(),
                    },
                );
            let item = QueuedItem {
                priority: QueuePriority::Background,
                // The labeled queue-strip row (TS `queuedAgentMessagePreview`:
                // an agent-session-message custom row previews as
                // "Agent message received: <details.message>").
                preview: Some(format!(
                    "{}: {message}",
                    pa_core::session_engine::agent_messaging::AGENT_MESSAGE_RECEIVED_PREVIEW_LABEL
                )),
                message: prompt,
                custom_message: Some(custom_message),
                // The agent-message marker: `agent_messages_clear` /
                // `agent_messages_pause` remove exactly these items.
                agent_message: Some(message.to_string()),
                queue_key: None,
                admission_id: None,
                images: Vec::new(),
                done: None,
                queue_visible: true,
                policy: TurnPolicy::Injected,
                forced_batch: false,
            };
            match lane {
                Lane::Steering => enqueue_priority(&mut core.steering, item),
                Lane::FollowUp => enqueue_priority(&mut core.follow_up, item),
            }
            let snapshot = self.snapshot_locked(&core);
            (id, queued, snapshot, target)
        };
        // The delivery checkpoint (busy=true): the queued agent message is
        // admitted live work — a restart must revive the worker to
        // deliver it (agent-to-agent messages have no client that
        // reopens the session). The operation names are TS's steer/follow-up
        // queue strings, matching the receipt's deliveryMode.
        self.checkpoint_queue(QueueCheckpoint::Admitted {
            operation: match lane {
                Lane::Steering => "steer_queued",
                Lane::FollowUp => "follow_up_queued",
            },
        });
        let _ = self.emit_action_update(&snapshot);
        self.work_notify.notify_one();
        let timestamp = crate::util::now_iso();
        let mut receipt = json!({
            "id": id,
            "source": AGENT_MESSAGE_SOURCE,
            "target": target,
            "message": message,
            // TS receipts always report `steer`; the follow-up lane is the
            // Rust extension for queue-behind-current-work delivery.
            "deliveryMode": if lane == Lane::FollowUp { "follow_up" } else { "steer" },
        });
        if queued {
            receipt["deliveryStatus"] = json!("queued");
            receipt["queuedAt"] = json!(timestamp);
        } else {
            receipt["deliveryStatus"] = json!("delivered");
            receipt["deliveredAt"] = json!(timestamp);
        }
        if !sender.is_null() {
            receipt["from"] = json!(sender);
        }
        response_success(None, "worker_deliver_message", Some(receipt))
    }
}
