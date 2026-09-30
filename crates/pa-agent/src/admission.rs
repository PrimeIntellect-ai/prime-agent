//! The generic admission seam: race-safe message admission and idle-wake
//! primitives an embedding composes into its own delivery policy (the
//! in-process host's terminal notices, session input serialization, and
//! any other custom-row flow).
//!
//! Ownership contract: this seam is generic — it knows message batches
//! and run slots, never child/notice/filesystem policy. The queues stay
//! the agent's own steering/follow-up queues (no admission-side second
//! queue), and pa-agent never spawns a watcher: the idle-queued wake is
//! a passive, stateful signal that acts only when a host-owned pump
//! subscribed through [`Agent::idle_queued_wake`] drives it.
//!
//! Delivery contract: an admitted batch runs as its own turn (admit-only
//! return — the turn settles through the events); a busy batch queues as
//! steering inside the same critical section that observed the busy run,
//! so it reaches either that run's next model boundary or, when the run
//! finishes first, the idle-queued wake's pump drain. Nothing strands
//! between the loop's final steering poll and the idle transition.

use std::sync::Arc;

use crate::agent::{
    Agent, AgentInner, AgentMessageBatch, AgentPromptInput, ClaimOrEnqueue, QueuedClaim,
};

/// Outcome of [`Agent::admit_or_enqueue`] — the atomic
/// enqueue-or-admit decision.
#[must_use]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AdmitStatus {
    /// The idle slot was claimed and a run started seeded with the batch;
    /// the call returned at run registration, and the turn settles
    /// through the events. A run failure after admission rides the
    /// events (the `prompt_until_accepted` contract), not this value.
    Admitted,
    /// A run was active; the batch was queued as steering under the same
    /// critical section that observed it. Delivery is guaranteed: the
    /// active run's steering polls, or the idle-queued wake once a
    /// host-owned pump drains it after the run finishes.
    Busy,
}

/// Outcome of [`Agent::admit_queued_turn`] — the host pump's
/// queue-preserving drain.
#[must_use]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum QueuedAdmission {
    /// The idle slot was claimed together with draining the queued
    /// steering (then follow-up) batches as the run's seed.
    Admitted,
    /// A run was active: nothing was drained, so every queued batch
    /// stays queued (never drain-then-lose).
    Busy,
    /// Nothing was queued at the claim (a coalesced or stale wake).
    Empty,
}

/// The busy refusal of [`Agent::admit_prompt_or_busy`]: a run is active,
/// nothing was admitted or queued. Typed so the embedding maps it
/// without string-matching; [`std::fmt::Display`] carries `Agent::prompt`'s
/// own refusal text, which the embedding rewrites into its session-level
/// busy error.
#[derive(Debug)]
pub struct AgentBusyRefusal;

impl std::fmt::Display for AgentBusyRefusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "Agent is already processing a prompt. Use steer() or followUp() to queue messages, or wait for completion."
        )
    }
}

impl std::error::Error for AgentBusyRefusal {}

/// The other half of an atomic prompt admission
/// ([`Agent::admit_prompt_or_busy`]): a claimed, self-driving run. The run
/// executes regardless of this handle; dropping the handle neither
/// cancels the run nor strands the claimed slot — the run settles through
/// the events exactly like a `prompt_until_accepted` run.
/// [`AdmittedTurn::settle`] additionally delivers the run's own result
/// to this caller.
#[derive(Debug)]
pub struct AdmittedTurn {
    result: tokio::sync::oneshot::Receiver<anyhow::Result<()>>,
}

impl AdmittedTurn {
    /// Await the whole run and propagate its result — the post-admission
    /// half of `Agent::prompt`: the run's failures already settled through
    /// the events, and this returns the same `Err` to the caller.
    ///
    /// # Errors
    ///
    /// Propagates the run's error, exactly like awaiting `Agent::prompt`
    /// after admission.
    pub async fn settle(self) -> anyhow::Result<()> {
        self.result
            .await
            .unwrap_or_else(|_| anyhow::bail!("the admitted run settled without a result"))
    }
}

impl Agent {
    /// Atomically admit the batch as a fresh turn, or — when a run is
    /// active — enqueue it as steering under the same lock section that
    /// observed the busy run. The decision is one critical section on the
    /// run slot: no second caller can claim the same idle window, and a
    /// busy-armed batch cannot land after a finishing run's queue check
    /// (the finish re-checks the queue inside the same lock). Never
    /// Never awaits a model turn (the decision is one synchronous
    /// critical section); a run failure after admission rides the
    /// events.
    ///
    /// # Panics
    ///
    /// Panics if the `model_override`, `run`, `steering_queue`, or
    /// `follow_up_queue` mutex is poisoned (another task panicked while
    /// holding one of them).
    pub fn admit_or_enqueue(&self, batch: impl Into<AgentMessageBatch>) -> AdmitStatus {
        let run_override = self.inner.model_override.lock().unwrap().clone();
        match self.inner.claim_or_enqueue(batch.into()) {
            ClaimOrEnqueue::Enqueued => AdmitStatus::Busy,
            ClaimOrEnqueue::Claimed { claim, batch } => {
                let messages = match batch {
                    AgentMessageBatch::Single(message) => vec![message],
                    AgentMessageBatch::Batch(messages) => messages,
                };
                let inner = Arc::clone(&self.inner);
                tokio::spawn(async move {
                    // Admission already returned; this run's failures
                    // settle through the events.
                    let _ = inner
                        .execute_prompt_claim(claim, run_override, messages, false)
                        .await;
                });
                AdmitStatus::Admitted
            }
        }
    }

    /// The host pump's drain: on an idle agent, claim the run slot
    /// together with draining the queued batches (steering first, then
    /// follow-ups) as the next turn's seed — no user prompt needed; on a
    /// busy agent, refuse without draining so every queued batch
    /// survives; when nothing is queued, report the coalesced or stale
    /// wake. The idle-queued wake is reflected inside the same critical
    /// section (armed for leftovers, cleared when the drain emptied the
    /// queues), so the pump converges without spinning.
    ///
    /// # Panics
    ///
    /// Panics if the `model_override`, `run`, `steering_queue`, or
    /// `follow_up_queue` mutex is poisoned (another task panicked while
    /// holding one of them).
    pub fn admit_queued_turn(&self) -> QueuedAdmission {
        let run_override = self.inner.model_override.lock().unwrap().clone();
        match self.inner.claim_or_drain() {
            QueuedClaim::Busy => QueuedAdmission::Busy,
            QueuedClaim::Empty => QueuedAdmission::Empty,
            QueuedClaim::Claimed {
                claim,
                messages,
                drained_follow_ups,
            } => {
                // A steering seed skips the loop's initial steering poll
                // (it IS the steering); a follow-up seed keeps polling
                // steering at the turn's start, like continue()'s drain.
                let skip_initial_steering_poll = !drained_follow_ups;
                let inner = Arc::clone(&self.inner);
                tokio::spawn(async move {
                    // Admission already returned; this run's failures
                    // settle through the events.
                    let _ = inner
                        .execute_prompt_claim(
                            claim,
                            run_override,
                            messages,
                            skip_initial_steering_poll,
                        )
                        .await;
                });
                QueuedAdmission::Admitted
            }
        }
    }

    /// Atomic prompt admission: one critical section on the run slot — a
    /// busy agent refuses with [`AgentBusyRefusal`] and NOTHING is
    /// admitted or queued (the batch stays with the caller; the
    /// steer/follow-up/error policy stays in the embedding), and an idle
    /// agent's slot is claimed on the spot with the run starting
    /// self-driving. The call is synchronous and holds no lock across
    /// an await, so a
    /// caller-side serialization lock (a session admission lock) can be
    /// held across it; the turn is awaited separately through
    /// [`AdmittedTurn::settle`].
    ///
    /// # Errors
    ///
    /// Returns [`AgentBusyRefusal`] when a run is active; nothing was
    /// admitted or queued. No other error exists at admission.
    ///
    /// # Panics
    ///
    /// Panics if the `model_override` or `run` mutex is poisoned (another
    /// task panicked while holding one of them).
    pub fn admit_prompt_or_busy(
        &self,
        input: impl Into<AgentPromptInput>,
    ) -> anyhow::Result<AdmittedTurn> {
        let messages = AgentInner::normalize_prompt_input(input.into());
        let run_override = self.inner.model_override.lock().unwrap().clone();
        let Some(claim) = self.inner.claim_run_slot(None) else {
            return Err(anyhow::Error::new(AgentBusyRefusal));
        };
        let (result_tx, result_rx) = tokio::sync::oneshot::channel();
        let inner = Arc::clone(&self.inner);
        tokio::spawn(async move {
            // The run is self-driving: it settles through the events even
            // if the caller dropped the handle before settling.
            let result = inner
                .execute_prompt_claim(claim, run_override, messages, false)
                .await;
            let _ = result_tx.send(result);
        });
        Ok(AdmittedTurn { result: result_rx })
    }

    /// The stateful idle-queued wake: `true` while a finished run left
    /// unconsumed steering/follow-up batches (the loop's final steering
    /// poll missed them, or a stop hook/abort skipped the polls). The
    /// value is stored in the channel, so an arming before the
    /// subscription is still visible (`borrow_and_update`) and no wake
    /// is lost; the run-finish critical section re-arms it on every
    /// finish with a non-empty queue. pa-agent never acts on this signal
    /// — a host-owned pump drives the drain through
    /// [`Agent::admit_queued_turn`].
    #[must_use]
    pub fn idle_queued_wake(&self) -> tokio::sync::watch::Receiver<bool> {
        self.inner.idle_queued_rx.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex as StdMutex;

    use crate::agent::{AgentInitialState, AgentOptions, AgentStateSnapshot};
    use crate::scripted::ScriptedProvider;
    use crate::stream::{AssistantMessageEvent, LlmContext, StreamFn, StreamRequestOptions};
    use crate::types::{
        AgentEvent, AgentMessage, AssistantContent, AssistantMessage, Message, Model, StopReason,
        TextContent, ThinkingLevel, Usage, UserContent, UserPart,
    };

    fn model(id: &str) -> Model {
        Model {
            id: id.to_string(),
            name: id.to_string(),
            api: "anthropic-messages".to_string(),
            provider: "anthropic".to_string(),
            base_url: String::new(),
            reasoning: true,
            cost: crate::types::UsageCost::default(),
            context_window: 200_000,
            max_tokens: 8_192,
        }
    }

    fn agent_with_stream(stream_fn: StreamFn) -> Agent {
        Agent::new(AgentOptions {
            initial_state: AgentInitialState {
                model: Some(model("session-model")),
                thinking_level: Some(ThinkingLevel::Off),
                system_prompt: Some("s".to_string()),
                ..Default::default()
            },
            stream_fn: Some(stream_fn),
            ..Default::default()
        })
    }

    /// One plain-text assistant response as an already-completed model
    /// stream.
    fn text_stream(model: &Model, text: &str) -> Box<dyn crate::stream::ModelStream> {
        let message = AssistantMessage {
            content: vec![AssistantContent::Text(TextContent {
                text: text.to_string(),
                text_signature: None,
            })],
            api: model.api.clone(),
            provider: model.provider.clone(),
            model: model.id.clone(),
            response_model: None,
            response_id: None,
            diagnostics: None,
            usage: Usage::zero(),
            stop_reason: StopReason::Stop,
            error_message: None,
            stop_reason_raw: None,
            timestamp: 0,
        };
        let (handle, consumer) = crate::stream::event_stream();
        handle.push(AssistantMessageEvent::Done {
            reason: StopReason::Stop,
            message: message.clone(),
        });
        handle.end(Some(message));
        Box::new(consumer)
    }

    /// A deterministic gated stream: every call publishes its call number
    /// on `called`, waits for `gate` to flip `true` (the test's mid-run
    /// admission point), records its context, then serves `turns[call-1]`
    /// — `Ok` as a plain text response, `Err` as a start-time provider
    /// failure. Calls are keyed by number, so a run that never reaches a
    /// model call cannot shift later turns.
    fn gated_stream_fn(
        turns: Vec<Result<&'static str, &'static str>>,
        called: Arc<tokio::sync::watch::Sender<u32>>,
        gate: Arc<tokio::sync::watch::Sender<bool>>,
        contexts: Arc<StdMutex<Vec<LlmContext>>>,
    ) -> StreamFn {
        Arc::new(
            move |requested: Model, context: LlmContext, _options: StreamRequestOptions| {
                let turns = turns.clone();
                let called = Arc::clone(&called);
                let gate = Arc::clone(&gate);
                let contexts = Arc::clone(&contexts);
                Box::pin(async move {
                    let next = *called.borrow() + 1;
                    called.send_replace(next);
                    let call = usize::try_from(next).expect("call numbers fit usize");
                    let mut gate_rx = gate.subscribe();
                    while !*gate_rx.borrow_and_update() {
                        if gate_rx.changed().await.is_err() {
                            break;
                        }
                    }
                    contexts.lock().unwrap().push(context);
                    match turns.get(call - 1).copied() {
                        Some(Ok(text)) => {
                            Ok(text_stream(&requested, text)
                                as Box<dyn crate::stream::ModelStream>)
                        }
                        Some(Err(message)) => Err(anyhow::anyhow!(message)),
                        None => Err(anyhow::anyhow!("gated stream exhausted")),
                    }
                })
            },
        )
    }

    /// The text of a user message's content.
    fn user_text(content: &UserContent) -> String {
        match content {
            UserContent::Text(text) => text.clone(),
            UserContent::Parts(parts) => parts
                .iter()
                .filter_map(|part| match part {
                    UserPart::Text(text) => Some(text.text.as_str()),
                    UserPart::Image(_) => None,
                })
                .collect::<Vec<_>>()
                .join(" "),
        }
    }

    /// (role, text) rows of the transcript; user texts unwrapped, other
    /// roles carry only their role.
    fn transcript(state: &AgentStateSnapshot) -> Vec<(&'static str, String)> {
        state
            .messages
            .iter()
            .map(|message| match message {
                AgentMessage::Standard(Message::User(user)) => ("user", user_text(&user.content)),
                AgentMessage::Standard(Message::Assistant(_)) => ("assistant", String::new()),
                AgentMessage::Standard(Message::ToolResult(_)) => ("toolResult", String::new()),
                AgentMessage::Custom(_) => ("custom", String::new()),
            })
            .collect()
    }

    /// (role, text) rows of one LLM call's user messages.
    fn llm_user_rows(context: &LlmContext) -> Vec<String> {
        context
            .messages
            .iter()
            .filter_map(|message| match message {
                Message::User(user) => Some(user_text(&user.content)),
                _ => None,
            })
            .collect()
    }

    #[tokio::test]
    async fn idle_admission_starts_turn_without_user_prompt() {
        let provider = Arc::new(ScriptedProvider::new(model("session-model")));
        provider.push_text_turn("ok");
        let agent = agent_with_stream(provider.stream_fn());

        let status = agent.admit_or_enqueue(AgentMessage::user("notice"));
        assert_eq!(status, AdmitStatus::Admitted);
        agent.wait_for_idle().await;

        let state = agent.state().await;
        assert!(!state.is_streaming);
        assert_eq!(
            transcript(&state),
            vec![("user", "notice".to_string()), ("assistant", String::new()),]
        );
    }

    #[tokio::test]
    async fn busy_admission_queues_steering_for_next_model_boundary() {
        let (called_tx, called_rx) = tokio::sync::watch::channel(0u32);
        let (gate_tx, _gate_rx) = tokio::sync::watch::channel(false);
        let called = Arc::new(called_tx);
        let gate = Arc::new(gate_tx);
        let contexts = Arc::new(StdMutex::new(Vec::<LlmContext>::new()));
        let agent = agent_with_stream(gated_stream_fn(
            vec![Ok("one"), Ok("two")],
            Arc::clone(&called),
            Arc::clone(&gate),
            Arc::clone(&contexts),
        ));

        let prompt_agent = agent.clone();
        let prompt_task = tokio::spawn(async move {
            prompt_agent
                .prompt(AgentPromptInput::text("go"))
                .await
                .expect("run");
        });
        let mut calls = called_rx;
        while *calls.borrow_and_update() < 1 {
            calls.changed().await.expect("first model call");
        }

        let status = agent.admit_or_enqueue(AgentMessage::user("notice"));
        assert_eq!(status, AdmitStatus::Busy);
        assert!(agent.has_queued_messages(), "the busy arm queued the batch");

        gate.send_replace(true);
        prompt_task.await.expect("prompt task alive");

        let recorded = contexts.lock().unwrap().clone();
        assert_eq!(recorded.len(), 2);
        assert_eq!(
            llm_user_rows(&recorded[1]),
            vec!["go".to_string(), "notice".to_string()],
            "the busy-armed batch reached the next model request"
        );
        assert!(!agent.has_queued_messages());
        assert!(
            !*agent.idle_queued_wake().borrow_and_update(),
            "a run that consumed its steering leaves the wake clear"
        );
    }

    #[tokio::test]
    async fn final_poll_leftovers_arm_idle_queued_wake_and_pump_delivers() {
        let provider = Arc::new(ScriptedProvider::new(model("session-model")));
        provider.push_text_turn("ok");
        provider.push_text_turn("ok2");
        let agent = agent_with_stream(provider.stream_fn());

        // The late row lands after the loop's final steering poll but
        // before the finish critical section: an AgentEnd listener runs
        // in exactly that window (after every poll, before the slot
        // clears).
        let late_agent = agent.clone();
        let steered = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let subscription = agent
            .subscribe(move |event, _| {
                let late_agent = late_agent.clone();
                let steered = Arc::clone(&steered);
                Box::pin(async move {
                    // Fire once, on the first run's end: the final-poll
                    // window exists for every run, and re-steering on the
                    // pumped turn's own end would arm the wake again.
                    if matches!(event, AgentEvent::AgentEnd { .. })
                        && !steered.swap(true, std::sync::atomic::Ordering::SeqCst)
                    {
                        late_agent.steer(AgentMessage::user("late"));
                    }
                    Ok(())
                })
            })
            .await;

        let mut wake = agent.idle_queued_wake();
        agent
            .prompt(AgentPromptInput::text("go"))
            .await
            .expect("run");

        assert!(
            *wake.borrow_and_update(),
            "the final-poll leftover armed the idle-queued wake"
        );
        // The wake is stateful: a subscription made after the arming
        // still sees it, so no wake is lost.
        assert!(*agent.idle_queued_wake().borrow_and_update());

        let drained = agent.admit_queued_turn();
        assert_eq!(drained, QueuedAdmission::Admitted);
        agent.wait_for_idle().await;

        let state = agent.state().await;
        assert_eq!(
            transcript(&state),
            vec![
                ("user", "go".to_string()),
                ("assistant", String::new()),
                ("user", "late".to_string()),
                ("assistant", String::new()),
            ],
            "the pump drove the leftover into a model turn with no user prompt"
        );
        assert!(
            !*wake.borrow_and_update(),
            "the drained-and-settled run cleared the wake"
        );
        assert!(!agent.has_queued_messages());
        subscription.unsubscribe().await;
    }

    #[tokio::test]
    async fn busy_drain_refusal_preserves_queued_batches() {
        let (called_tx, called_rx) = tokio::sync::watch::channel(0u32);
        let (gate_tx, _gate_rx) = tokio::sync::watch::channel(false);
        let called = Arc::new(called_tx);
        let gate = Arc::new(gate_tx);
        let contexts = Arc::new(StdMutex::new(Vec::<LlmContext>::new()));
        let agent = agent_with_stream(gated_stream_fn(
            vec![Ok("one"), Ok("two")],
            Arc::clone(&called),
            Arc::clone(&gate),
            Arc::clone(&contexts),
        ));

        let prompt_agent = agent.clone();
        let prompt_task = tokio::spawn(async move {
            prompt_agent
                .prompt(AgentPromptInput::text("go"))
                .await
                .expect("run");
        });
        let mut calls = called_rx;
        while *calls.borrow_and_update() < 1 {
            calls.changed().await.expect("first model call");
        }

        assert_eq!(
            agent.admit_or_enqueue(AgentMessage::user("n1")),
            AdmitStatus::Busy
        );
        assert_eq!(
            agent.admit_queued_turn(),
            QueuedAdmission::Busy,
            "a drain against an active run refuses"
        );
        assert!(
            agent.has_queued_messages(),
            "the refused drain preserved the batch (never drain-then-lose)"
        );

        gate.send_replace(true);
        prompt_task.await.expect("prompt task alive");

        let recorded = contexts.lock().unwrap().clone();
        assert_eq!(recorded.len(), 2);
        assert_eq!(
            llm_user_rows(&recorded[1]),
            vec!["go".to_string(), "n1".to_string()],
            "the preserved batch reached the run's next model boundary"
        );
        assert_eq!(
            agent.admit_queued_turn(),
            QueuedAdmission::Empty,
            "a coalesced drain with nothing queued reports Empty"
        );
    }

    #[tokio::test]
    async fn double_admission_from_idle_admits_once_queues_second() {
        let (called_tx, called_rx) = tokio::sync::watch::channel(0u32);
        let (gate_tx, _gate_rx) = tokio::sync::watch::channel(false);
        let called = Arc::new(called_tx);
        let gate = Arc::new(gate_tx);
        let contexts = Arc::new(StdMutex::new(Vec::<LlmContext>::new()));
        let agent = agent_with_stream(gated_stream_fn(
            vec![Ok("one"), Ok("two")],
            Arc::clone(&called),
            Arc::clone(&gate),
            Arc::clone(&contexts),
        ));

        assert_eq!(
            agent.admit_or_enqueue(AgentMessage::user("a")),
            AdmitStatus::Admitted,
            "the synchronous claim makes sequential admissions deterministic"
        );
        let mut calls = called_rx;
        while *calls.borrow_and_update() < 1 {
            calls.changed().await.expect("first model call");
        }
        assert_eq!(
            agent.admit_or_enqueue(AgentMessage::user("b")),
            AdmitStatus::Busy
        );

        gate.send_replace(true);
        agent.wait_for_idle().await;

        let recorded = contexts.lock().unwrap().clone();
        assert_eq!(recorded.len(), 2);
        assert_eq!(
            llm_user_rows(&recorded[1]),
            vec!["a".to_string(), "b".to_string()],
            "both batches reached the model in admission order"
        );
        let state = agent.state().await;
        assert_eq!(
            transcript(&state),
            vec![
                ("user", "a".to_string()),
                ("assistant", String::new()),
                ("user", "b".to_string()),
                ("assistant", String::new()),
            ]
        );
    }

    #[tokio::test]
    async fn aborted_admission_settles_and_frees_the_slot() {
        let (called_tx, _called_rx) = tokio::sync::watch::channel(0u32);
        let (gate_tx, _gate_rx) = tokio::sync::watch::channel(false);
        let called = Arc::new(called_tx);
        let gate = Arc::new(gate_tx);
        let contexts = Arc::new(StdMutex::new(Vec::<LlmContext>::new()));
        let agent = agent_with_stream(gated_stream_fn(
            vec![Ok("one"), Ok("two")],
            Arc::clone(&called),
            Arc::clone(&gate),
            Arc::clone(&contexts),
        ));

        assert_eq!(
            agent.admit_or_enqueue(AgentMessage::user("a")),
            AdmitStatus::Admitted
        );
        agent.abort();
        agent.wait_for_idle().await;

        let state = agent.state().await;
        assert!(!state.is_streaming, "the aborted run settled");
        assert!(
            !*agent.idle_queued_wake().borrow_and_update(),
            "an abort with empty queues leaves the wake clear"
        );

        // The slot is free: the next admission claims it. Open the model
        // gate first so an early abort cannot strand this second run.
        gate.send_replace(true);
        assert_eq!(
            agent.admit_or_enqueue(AgentMessage::user("b")),
            AdmitStatus::Admitted
        );
        agent.wait_for_idle().await;

        let state = agent.state().await;
        assert!(!state.is_streaming);
        let rows = transcript(&state);
        assert!(rows.contains(&("user", "b".to_string())));
        assert_eq!(
            rows.last(),
            Some(&("assistant", String::new())),
            "the post-abort admission completed its turn"
        );
    }

    #[tokio::test]
    async fn admit_prompt_or_busy_admits_settles_and_refuses_busy() {
        let (called_tx, called_rx) = tokio::sync::watch::channel(0u32);
        let (gate_tx, _gate_rx) = tokio::sync::watch::channel(false);
        let called = Arc::new(called_tx);
        let gate = Arc::new(gate_tx);
        let contexts = Arc::new(StdMutex::new(Vec::<LlmContext>::new()));
        let agent = agent_with_stream(gated_stream_fn(
            vec![Ok("one"), Err("provider exploded")],
            Arc::clone(&called),
            Arc::clone(&gate),
            Arc::clone(&contexts),
        ));

        let turn = agent
            .admit_prompt_or_busy(AgentPromptInput::text("go"))
            .expect("idle prompt admission");
        let mut calls = called_rx;
        while *calls.borrow_and_update() < 1 {
            calls.changed().await.expect("first model call");
        }

        // A second serialized admission while the first run holds the
        // slot: the typed busy refusal, with nothing admitted or queued.
        let refusal = agent.admit_prompt_or_busy(AgentPromptInput::text("second"));
        let error = refusal.expect_err("busy refusal");
        assert!(error.downcast_ref::<AgentBusyRefusal>().is_some());
        assert!(
            !agent.has_queued_messages(),
            "the busy refusal admitted and queued nothing"
        );

        gate.send_replace(true);
        turn.settle()
            .await
            .expect("the run's result reaches the caller");

        // Run-error propagation parity with prompt(): the next admitted
        // turn's provider failure surfaces through settle().
        let failing = agent
            .admit_prompt_or_busy(AgentPromptInput::text("again"))
            .expect("idle prompt admission");
        let error = failing
            .settle()
            .await
            .expect_err("the failing run's error reaches the caller");
        assert!(error.to_string().contains("provider exploded"));
    }

    #[tokio::test]
    async fn admitted_turn_drop_does_not_strand_the_claimed_slot() {
        let (called_tx, called_rx) = tokio::sync::watch::channel(0u32);
        let (gate_tx, _gate_rx) = tokio::sync::watch::channel(false);
        let called = Arc::new(called_tx);
        let gate = Arc::new(gate_tx);
        let contexts = Arc::new(StdMutex::new(Vec::<LlmContext>::new()));
        let agent = agent_with_stream(gated_stream_fn(
            vec![Ok("one"), Ok("after")],
            Arc::clone(&called),
            Arc::clone(&gate),
            Arc::clone(&contexts),
        ));

        let turn = agent
            .admit_prompt_or_busy(AgentPromptInput::text("go"))
            .expect("idle prompt admission");
        let mut calls = called_rx;
        while *calls.borrow_and_update() < 1 {
            calls.changed().await.expect("first model call");
        }
        drop(turn);

        gate.send_replace(true);
        agent.wait_for_idle().await;
        assert!(!agent.state().await.is_streaming);

        // The self-driving run freed the slot: the next prompt runs.
        agent
            .prompt(AgentPromptInput::text("after"))
            .await
            .expect("run");
        let state = agent.state().await;
        assert!(transcript(&state).contains(&("user", "after".to_string())));
    }

    #[tokio::test]
    async fn continue_run_drains_a_queued_batch_atomically() {
        let provider = Arc::new(ScriptedProvider::new(model("session-model")));
        provider.push_text_turn("ok");
        let agent = agent_with_stream(provider.stream_fn());

        agent.steer(AgentMessage::user("queued"));
        agent.continue_run().await.expect("queued continuation");

        let state = agent.state().await;
        assert_eq!(
            transcript(&state),
            vec![("user", "queued".to_string()), ("assistant", String::new()),],
            "the queued batch seeded the continuation turn"
        );
        assert!(!agent.has_queued_messages());
    }

    #[tokio::test]
    async fn continue_run_busy_refusal_preserves_the_queued_batch() {
        let (called_tx, called_rx) = tokio::sync::watch::channel(0u32);
        let (gate_tx, _gate_rx) = tokio::sync::watch::channel(false);
        let called = Arc::new(called_tx);
        let gate = Arc::new(gate_tx);
        let contexts = Arc::new(StdMutex::new(Vec::<LlmContext>::new()));
        let agent = agent_with_stream(gated_stream_fn(
            vec![Ok("one"), Ok("two")],
            Arc::clone(&called),
            Arc::clone(&gate),
            Arc::clone(&contexts),
        ));

        let prompt_agent = agent.clone();
        let prompt_task = tokio::spawn(async move {
            prompt_agent
                .prompt(AgentPromptInput::text("go"))
                .await
                .expect("run");
        });
        let mut calls = called_rx;
        while *calls.borrow_and_update() < 1 {
            calls.changed().await.expect("first model call");
        }

        agent.steer(AgentMessage::user("queued"));
        let error = agent.continue_run().await.expect_err("busy refusal");
        let continue_error = error
            .downcast_ref::<crate::agent::AgentContinueError>()
            .expect("typed continue error");
        assert_eq!(
            continue_error.code,
            crate::agent::AgentContinueErrorCode::Busy
        );
        assert!(
            agent.has_queued_messages(),
            "the busy refusal preserved the batch"
        );

        gate.send_replace(true);
        prompt_task.await.expect("prompt task alive");

        let recorded = contexts.lock().unwrap().clone();
        assert_eq!(recorded.len(), 2);
        assert_eq!(
            llm_user_rows(&recorded[1]),
            vec!["go".to_string(), "queued".to_string()],
            "the preserved batch reached the run's next model boundary"
        );
    }
}
