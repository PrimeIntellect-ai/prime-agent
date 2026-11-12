//! The input handlers behind dispatch: prompt delivery, queue
//! operations, and agent-message delivery.
use super::{
    admit_inbox_notice, enqueue_priority, json, oneshot, parse_custom_message, parse_prompt_images,
    response_success, sender_is_child_of, AgentFamilyRelationship, AgentMessagePromptPayload, Lane,
    QueueCheckpoint, QueuePriority, QueuedItem, TurnPolicy, Worker, AGENT_MESSAGE_SOURCE,
    DEFAULT_AGENT_MESSAGE_MAX_PENDING_PER_SESSION, QUEUED_INPUT_SUSPENDED,
};

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
        // TS has no empty check; this port still rejects a prompt with neither text nor images.
        let images = parse_prompt_images(payload);
        if message.is_empty() && images.is_empty() {
            return response_failure(None, "prompt", "Prompt cannot be empty", None);
        }
        let streaming_behavior = payload.get("streamingBehavior").and_then(Value::as_str);
        let custom_message = match parse_custom_message(payload.get("customMessage")) {
            Ok(custom_message) => custom_message,
            Err(error) => return response_failure(None, "prompt", &error, None),
        };
        // The reserved child-status kinds are daemon provenance: a prompt row
        // claiming one is always a spoof — answered loudly, never parked. The
        // inbox notice kind is the same provenance (the daemon's admission
        // paths own it), so it refuses identically.
        if let Some(row) = custom_message.as_ref() {
            if crate::child_status_notices::is_reserved_child_status_custom_type(row) {
                return response_failure(
                    None,
                    "prompt",
                    &crate::child_status_notices::reserved_intake_error(),
                    None,
                );
            }
            if crate::worker::is_inbox_notice_custom_type(row) {
                return response_failure(
                    None,
                    "prompt",
                    &crate::worker::inbox_notice_intake_error(),
                    None,
                );
            }
        }
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
        // it so the turn runner clears the admission at settle.
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
            // TS commits before accepting the prompt into its action queue.
            // Hold the queue lock across this transition and enqueue so a
            // cancellation cannot mistake an accepted prompt for waiting.
            if let Some(id) = &admission_id {
                if !self.prompt_admissions.commit(id) {
                    return response_failure(
                        None,
                        if wait { "prompt_and_wait" } else { "prompt" },
                        "Prompt admission was cancelled.",
                        None,
                    );
                }
            }
            // An idle session runs the prompt immediately: the lane is the
            // work hand-off, not a queue, so the projection did not change
            // (TS prompt admission with queueIfBusy=false never queues).
            let queued_behind_work = core.busy;
            let lane = match streaming_behavior {
                Some("steer") => Lane::Steering,
                // An idle session's prompt IS the next run, so it takes the steering
                // lane — otherwise a steering delivery arriving in the same window would
                // jump the prompt's turn.
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
            let snapshot = Self::snapshot_locked(&core);
            (snapshot, queued_behind_work)
        };
        // The admission checkpoint: the admitted prompt is undelivered
        // live work until its turn settles.
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
        // These commands are resume sites: an admitted turn with
        // `wake: "immediate"` resumes the suspension.
        self.resume_queued_input();
        let message = payload
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let custom_message = match parse_custom_message(payload.get("customMessage")) {
            Ok(custom_message) => custom_message,
            Err(error) => return response_failure(None, lane.as_str(), &error, None),
        };
        // The reserved child-status kinds are daemon provenance: a caller-supplied
        // row claiming one is answered loudly, never parked. The daemon's own
        // notice injection rides this command with the one-shot capability.
        // The inbox notice kind carries the same provenance with NO client
        // route (the daemon's inbox paths admit it), so it refuses outright.
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
            if crate::worker::is_inbox_notice_custom_type(row) {
                return response_failure(
                    None,
                    lane.as_str(),
                    &crate::worker::inbox_notice_intake_error(),
                    None,
                );
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
        let snapshot = Self::snapshot_locked(&core);
        drop(core);
        // The queue-write checkpoint: an undelivered lane is live work. The
        // operation names are TS's journal strings, so the journals stay
        // comparable record-for-record.
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

    /// Agent-to-agent delivery: render the `[agent-message from ...]` prompt and queue
    /// it on the requested lane with the `agent_message` custom row (the turn renders
    /// the collapsed card). Answers `queued` when running, else `delivered`.
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
        // On a suspended idle session the delivery is rejected with the same
        // admission error as a plain prompt; only the busy carve-out queues it
        // parked.
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
        // The relationship label derives from the sender's durable parent edge,
        // never the runtime kind alone: a subagent spawned by a DIFFERENT parent
        // is not this session's child.
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
                sender_name: sender_name.clone(),
                from_relationship,
            },
        );
        let lane = if payload.get("deliveryMode").and_then(Value::as_str) == Some("follow_up") {
            Lane::FollowUp
        } else {
            Lane::Steering
        };
        // The agent-inbox route (default on): the delivered prompt lands
        // in the session's durable inbox, and ONE short coalesced notice
        // wakes on the delivery's lane instead of steering the full
        // `[agent-message from ...]` row. `agentInbox.enabled: false`
        // restores the direct row below.
        let inbox_on = self.agent_engine.as_ref().is_some_and(|engine| {
            crate::agent_inbox::inbox_enabled(&engine.cwd(), &self.config.agent_dir)
        });
        let inbox_route = self.agent_engine.as_ref().and_then(|engine| {
            if !inbox_on {
                return None;
            }
            engine
                .inbox()
                .map(|inbox| (std::sync::Arc::clone(engine), inbox))
        });
        if let Some((engine, inbox)) = inbox_route {
            let (id, queued, target) = {
                let (core, inputs) = self.summary_inputs();
                let id =
                    pa_core::session_engine::agent_messaging::create_agent_session_message_id();
                // The closed-branch receipt's sample; the live path's
                // receipt follows the admission's own under-lock sample.
                let queued = core.busy;
                let summary = self.summary_locked(&core, inputs);
                // The receiving session's endpoint for the receipt's `target`.
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
                (id, queued, target)
            };
            // The provenance the targeted reads filter on: the sender
            // name, the message id, and the family relationship.
            let mut meta = json!({ "id": &id, "from": &sender });
            if let Some(relationship) = from_relationship {
                meta["relationship"] = json!(relationship.as_str());
            }
            let notice = pa_core::session_engine::inbox::InboxNotice {
                class: pa_core::session_engine::inbox::INBOX_CLASS_AGENT_MESSAGE,
                sender: Some(sender_name),
                text: prompt,
                meta,
            };
            if engine.session_is_closed() {
                // A closed session takes no lane row and no wake (the
                // notice sink drops the same way): the message stays
                // durable in the inbox, so a reopened session reads it.
                // The same capacity bound holds (counted under the core
                // lock, the store push riding the documented order).
                {
                    let core = self.core.lock().unwrap();
                    let pending = pending_agent_messages(&inbox, &core.steering, &core.follow_up);
                    if let Err(error) =
                        pa_core::session_engine::agent_messaging::assert_agent_message_queue_capacity(
                            pending,
                            DEFAULT_AGENT_MESSAGE_MAX_PENDING_PER_SESSION,
                        )
                    {
                        return response_failure(
                            None,
                            "worker_deliver_message",
                            &error.to_string(),
                            None,
                        );
                    }
                    // The append is atomic with the retire: the slot's own
                    // mutex covers the identity re-check and the journal
                    // append, so a `clear_inbox` racing this delivery either
                    // waits for the append (the replacement's build opens
                    // the journal only after the clear, with the record
                    // already on disk) or lands first and refuses here —
                    // two stores never race the same journal across the
                    // swap.
                    if engine
                        .push_to_live_inbox(&inbox, notice, pa_core::autonomous::now_millis())
                        .is_none()
                    {
                        drop(core);
                        return response_failure(
                            None,
                            "worker_deliver_message",
                            "Target session is closed",
                            None,
                        );
                    }
                }
                let receipt = agent_message_receipt(&id, &target, message, lane, queued, &sender);
                return response_success(None, "worker_deliver_message", Some(receipt));
            }
            // The capacity bound counts waiting inbox messages too, and
            // it is re-checked inside the admission's critical section
            // (the lane lengths read from the locked core): concurrent
            // deliveries can never pass one stale sample together.
            let capacity_error = {
                let inbox = std::sync::Arc::clone(&inbox);
                move |steering: &std::collections::VecDeque<QueuedItem>,
                      follow_up: &std::collections::VecDeque<QueuedItem>| {
                    pa_core::session_engine::agent_messaging::assert_agent_message_queue_capacity(
                        pending_agent_messages(&inbox, steering, follow_up),
                        DEFAULT_AGENT_MESSAGE_MAX_PENDING_PER_SESSION,
                    )
                    .err()
                    .map(|error| error.to_string())
                }
            };
            let closed_engine = std::sync::Arc::clone(&engine);
            // The admission answers whether ITS busy sample parked the
            // notice: the receipt's `deliveryStatus` follows that sample,
            // never the earlier one taken outside the lock.
            let queued = match admit_inbox_notice(
                &self.recovery,
                &self.core,
                &self.work_notify,
                &inbox,
                &self.inbox_arrivals,
                notice,
                lane,
                move || closed_engine.session_is_closed(),
                capacity_error,
                Some(engine.as_ref()),
            ) {
                Ok(queued) => queued,
                Err(error) => {
                    return response_failure(None, "worker_deliver_message", &error, None);
                }
            };
            // The direct route's strip refresh: the queued notice row
            // must reach the clients like any other lane change. The
            // projection recomputes under the emission lock, so a
            // concurrent read hook's newer strip is never overwritten by
            // a stale copy.
            let _ = crate::worker::emit_action_update_fresh(&self.core, &self.events);
            // The notice is admitted live work — a restart must revive
            // the worker to deliver it (no client reopens the session).
            let receipt = agent_message_receipt(&id, &target, message, lane, queued, &sender);
            return response_success(None, "worker_deliver_message", Some(receipt));
        }
        // A retiring session with the inbox on but no store left takes
        // no lane row either: refuse instead of injecting the raw row
        // the kernel-notice sink would drop.
        if inbox_on
            && self
                .agent_engine
                .as_ref()
                .is_some_and(|engine| engine.session_is_closed())
        {
            return response_failure(
                None,
                "worker_deliver_message",
                "Target session is closed",
                None,
            );
        }
        let (id, queued, snapshot, target) = {
            let (mut core, inputs) = self.summary_inputs();
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
            let summary = self.summary_locked(&core, inputs);
            // The receiving session's endpoint: the receipt's `target`
            // and the delivered row's `details.target` share the one
            // shape.
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
            // The queued turn carries the `agent_message` row so the transcript renders
            // the collapsed card, while the row's `content` IS the rendered prompt —
            // the model context stays byte-identical to the plain-prompt delivery.
            let custom_message =
                pa_core::session_engine::agent_messaging::create_agent_session_message_row(
                    &pa_core::session_engine::agent_messaging::AgentSessionMessageRowPayload {
                        id: &id,
                        prompt: &prompt,
                        message,
                        from: &sender,
                        from_relationship,
                        target: Some(&target),
                        timestamp: crate::util::now_ms(),
                    },
                );
            let item = QueuedItem {
                priority: QueuePriority::Background,
                // The labeled queue-strip row: "Agent message
                // received: <details.message>".
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
            let snapshot = Self::snapshot_locked(&core);
            (id, queued, snapshot, target)
        };
        // The queued agent message is admitted live work — a restart must revive
        // the worker to deliver it (no client reopens the session).
        self.checkpoint_queue(QueueCheckpoint::Admitted {
            operation: match lane {
                Lane::Steering => "steer_queued",
                Lane::FollowUp => "follow_up_queued",
            },
        });
        let _ = self.emit_action_update(&snapshot);
        self.work_notify.notify_one();
        let receipt = agent_message_receipt(&id, &target, message, lane, queued, &sender);
        response_success(None, "worker_deliver_message", Some(receipt))
    }
}

/// The a2a pending count: waiting inbox agent messages plus queued
/// direct-route marker rows. The coalesced wake rows ride one notice per
/// batch, so they never consume the cap.
fn pending_agent_messages(
    inbox: &pa_core::session_engine::inbox::SessionInbox,
    steering: &std::collections::VecDeque<QueuedItem>,
    follow_up: &std::collections::VecDeque<QueuedItem>,
) -> usize {
    let waiting = inbox
        .count()
        .2
        .get(pa_core::session_engine::inbox::INBOX_CLASS_AGENT_MESSAGE)
        .copied()
        .unwrap_or(0) as usize;
    let queued = steering
        .iter()
        .chain(follow_up.iter())
        .filter(|item| item.agent_message.is_some())
        .count();
    queued + waiting
}

/// The `worker_deliver_message` receipt for one accepted delivery (the
/// direct-row and inbox routes answer the same shape).
fn agent_message_receipt(
    id: &str,
    target: &Value,
    message: &str,
    lane: Lane,
    queued: bool,
    sender: &Value,
) -> Value {
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
    receipt
}
