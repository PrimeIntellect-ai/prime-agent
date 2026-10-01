//! The scripted faux session (moved with its concern): the deterministic
//! replay engine for the integration harness, its script records, the
//! `SessionEngine` impl, and the abortable delay helper.
use super::{
    json, AbortSignal, AssistantSnapshot, BranchSummaryOutcome, BranchSummaryRequest,
    BranchSummaryRun, CompactionOutcome, CompactionRequest, CompactionRun, EngineEvent,
    PromptRequest, ProviderRetryPolicy, Result, SessionEngine, SideQuestionOutcome,
    SideQuestionRequest, SideQuestionSink, Value, UNBOUNDED_BACKOFF_MS,
};

/// A scripted faux session: replays a deterministic sequence of assistant
/// messages for the first N prompts, then echoes. Script format (JSON):
/// `{"responses": ["text one", {"text": "two", "delayMs": 250}],
/// "sideQuestion": {"responses": [...], "retry": {...}}}`.
///
/// A scripted tool call (the roster-activity fixture):
/// `{"toolCallId": "call-1", "toolName": "bash", "args": {...},
/// "result": "listing", "isError": false, "delayMs": 250}` emits the real
/// loop's tool-call lifecycle around the response's final assistant
/// message — `tool_execution_start`, the scripted hold,
/// `tool_execution_end`, the `toolResult` message — so worker tests drive
/// the in-flight tool-call tracking (the hold lets the roster feed
/// publish the mid-tool state before the tool settles).
///
/// The `compaction` seam scripts compaction results, one scripted result
/// per run (replayed from the top each run):
/// `{"summary": "...", "firstKeptEntryId": "...", "tokensBefore": 123,
/// "details": {"readFiles": [], "modifiedFiles": []}, "usage": {...},
/// "delayMs": 250}` compacts; `{"error": "...", "skipped": true}` reports
/// nothing-to-compact; `{"error": "..."}` fails the run; `delayMs` holds the
/// run in flight so aborts and mid-run state reads are observable.
///
/// The `sideQuestion` seam scripts the side-question provider calls, one
/// scripted result per attempt: `{"text": "...", "delayMs": 250}` answers,
/// `{"error": "...", "kind": "server_error", "status": 500,
/// "retryAfterMs": 100}` fails that attempt (retried per `retry`, which is
/// the shared provider policy with test-friendly delays). Verification
/// harness only; never set by the product.
#[derive(Debug, Default)]
pub struct ScriptedEngine {
    responses: Vec<Value>,
    side_question: SideQuestionScript,
    compaction: CompactionScript,
    branch_summary: CompactionScript,
    goal: Option<ScriptedGoal>,
    /// The script's resolved-model fixture (`{"model": {"id": ...,
    /// "provider": ..., "reasoning": ...}}`, the connection-state wire
    /// shape `model_metadata` serves): the harness reports NO model
    /// unless the script scripts one, so the roster/list surfaces stay
    /// empty for plain scripts exactly like before (an e2e that needs a
    /// model-dependent client behavior — the Anthropic subscription
    /// warning's provider gate — opts in).
    model: Option<Value>,
}

/// A scripted thread goal (the post-compaction goal-continue fixture):
/// `{"goal": {"status": "active", "objective": "...", "message": "..."}}`.
/// The scripted state answers `goal_state_value`; the mint returns the
/// follow-up turn (`message` is the continuation prompt text, defaulting
/// to the objective) with the goal-context custom row as the injected
/// message.
#[derive(Debug)]
struct ScriptedGoal {
    state: Value,
    message: String,
    /// Verification fixture only: emit the scripted state as a
    /// `goal_update` engine event during a turn (the real engine's
    /// announcement path), so worker tests drive the durable
    /// `thread_goal_state` mirror.
    emit_update_on_prompt: bool,
}

/// Scripted compaction results, consumed one per run in order; when the
/// script runs out, runs replay from the top (like side questions).
#[derive(Debug, Default)]
struct CompactionScript {
    responses: Vec<Value>,
    next: std::sync::atomic::AtomicUsize,
}

/// Scripted side-question provider results, consumed one per attempt.
#[derive(Debug, Clone, Default)]
struct SideQuestionScript {
    responses: Vec<Value>,
    /// Retry policy for scripted provider failures; `None` uses the shared
    /// default policy.
    retry: Option<ProviderRetryPolicy>,
}

impl ScriptedEngine {
    /// Build the scripted engine from its JSON shape; every missing or
    /// malformed script field takes its default.
    ///
    /// # Errors
    ///
    /// Never errors (the script shape is total and every field defaults);
    /// the `Result` return keeps the constructor uniform with the other
    /// builders.
    pub fn from_value(script: &Value) -> Result<Self> {
        let responses = script
            .get("responses")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let side_question = script
            .get("sideQuestion")
            .map(|side_question| SideQuestionScript {
                responses: side_question
                    .get("responses")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default(),
                retry: side_question.get("retry").map(|retry| ProviderRetryPolicy {
                    enabled: retry
                        .get("enabled")
                        .and_then(Value::as_bool)
                        .unwrap_or(true),
                    max_retries: retry.get("maxRetries").and_then(Value::as_u64).unwrap_or(0)
                        as u32,
                    base_delay_ms: retry
                        .get("baseDelayMs")
                        .and_then(Value::as_u64)
                        .unwrap_or(0),
                    max_retry_delay_ms: retry
                        .get("maxRetryDelayMs")
                        .and_then(Value::as_u64)
                        .unwrap_or(0),
                    max_delay_ms: UNBOUNDED_BACKOFF_MS,
                }),
            })
            .unwrap_or_default();
        let compaction = script
            .get("compaction")
            .map(|compaction| CompactionScript {
                responses: compaction
                    .get("responses")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default(),
                next: std::sync::atomic::AtomicUsize::new(0),
            })
            .unwrap_or_default();
        let branch_summary = script
            .get("branchSummary")
            .map(|branch_summary| CompactionScript {
                responses: branch_summary
                    .get("responses")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default(),
                next: std::sync::atomic::AtomicUsize::new(0),
            })
            .unwrap_or_default();
        let goal = script
            .get("goal")
            .filter(|goal| !goal.is_null())
            .map(|goal| ScriptedGoal {
                state: goal.get("state").cloned().unwrap_or_else(|| {
                    json!({
                        "active": goal.get("status").and_then(Value::as_str) == Some("active"),
                        "status": goal.get("status").cloned().unwrap_or(json!("idle")),
                        "objective": goal.get("objective").cloned().unwrap_or(Value::Null),
                        "continuationsUsed": 0,
                    })
                }),
                message: goal.get("message").and_then(Value::as_str).map_or_else(
                    || {
                        format!(
                            "[goal: continuation]\n\n{}",
                            goal.get("objective").and_then(Value::as_str).unwrap_or("")
                        )
                    },
                    str::to_string,
                ),
                emit_update_on_prompt: goal
                    .get("emitUpdateOnPrompt")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
            });
        let model = script
            .get("model")
            .filter(|model| !model.is_null())
            .cloned();
        Ok(ScriptedEngine {
            responses,
            side_question,
            compaction,
            branch_summary,
            goal,
            model,
        })
    }

    /// Build the scripted engine from a JSON file on disk.
    ///
    /// # Errors
    ///
    /// Returns an error when the file cannot be read or its JSON cannot
    /// be parsed; the parsed value itself never errors (see
    /// [`ScriptedEngine::from_value`]).
    pub fn from_file(path: &std::path::Path) -> Result<Self> {
        let content = std::fs::read_to_string(path)?;
        Self::from_value(&serde_json::from_str(&content)?)
    }

    fn response_text(response: &Value) -> String {
        match response {
            Value::String(text) => text.clone(),
            Value::Object(_) => response
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            _ => String::new(),
        }
    }

    fn response_delay_ms(response: &Value) -> u64 {
        response
            .get("delayMs")
            .and_then(Value::as_u64)
            .unwrap_or(0)
            .min(60_000)
    }
}

/// Plausible usage block so scripted messages match the real engine's wire
/// shape (and exercise summary aggregation).
fn scripted_usage() -> Value {
    json!({
        "input": 120, "output": 8, "cacheRead": 0, "cacheWrite": 0,
        "totalTokens": 128,
        "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0 },
    })
}

impl SessionEngine for ScriptedEngine {
    /// The script's model fixture, when one is scripted (`{"model":
    /// {"id": ..., "provider": ..., "reasoning": ...}}`): absent (the
    /// plain harness scripts), no model is reported — the TS scripted
    /// harness reports no resolved model on the session summary
    /// (`summaryForActiveSession` reads the agent's model, unset in the
    /// harness), so the roster summary and the CLI `list` table stay
    /// empty for scripted sessions and the `faux-1` id rides on the
    /// message rows only.
    fn model_metadata(&self) -> Option<Value> {
        self.model.clone()
    }

    /// The scripted thread goal's state, or the empty state (no goal
    /// section scripted).
    fn goal_state_value(&self) -> Value {
        self.goal.as_ref().map_or_else(
            || serde_json::to_value(pa_core::goals::empty_goal_state()).unwrap_or(Value::Null),
            |goal| goal.state.clone(),
        )
    }

    /// The scripted post-compaction mint: one continuation turn built from
    /// the goal section (the goal-context row as the injected message).
    fn mint_post_compaction_goal_continuation(&self) -> Option<crate::engine::GoalContinuation> {
        let goal = self.goal.as_ref()?;
        Some(crate::engine::GoalContinuation {
            request: crate::engine::PromptRequest {
                batch: Vec::new(),
                message: goal.message.clone(),
                images: Vec::new(),
                source: "user".to_string(),
                agent_message_id: None,
                custom_message: Some(json!({
                    "role": "custom",
                    "customType": "goal_context",
                    "content": goal.message,
                    "display": true,
                    "details": {
                        "kind": "continuation",
                        "objective": goal.state.get("objective").cloned().unwrap_or(Value::Null),
                    },
                    "timestamp": crate::util::now_ms(),
                })),
            },
            goal_update: Some(goal.state.clone()),
            // The scripted faux mints through no real driver: no guard.
            pending_handle: None,
        })
    }

    fn run_prompt(
        &self,
        prompt_index: usize,
        request: PromptRequest,
        aborted: &dyn Fn() -> bool,
        emit: &mut dyn FnMut(EngineEvent) -> bool,
    ) {
        let cancelled = || EngineEvent::Done(Err("prompt cancelled".to_string()));
        let scripted = self.responses.get(prompt_index).cloned();
        let text = match &scripted {
            Some(response) => {
                // The scripted hold honors the worker's cancel probe: a
                // close on a held scripted child settles at the abort,
                // not at the hold's end.
                let delay = std::time::Duration::from_millis(Self::response_delay_ms(response));
                if !abortable_sleep(delay, aborted) {
                    emit(cancelled());
                    return;
                }
                Self::response_text(response)
            }
            None => format!("echo: {}", request.message),
        };
        // An injected custom row replaces the accepted user message: the
        // turn persists and renders the row, then runs on `message` (the
        // real engine's injected-prompt contract, mirrored here so the
        // scripted harness exercises the same worker path).
        let accepted_row = match &request.custom_message {
            Some(custom) => custom.clone(),
            None => json!({
                "role": "user",
                "content": request.message.clone(),
                "timestamp": crate::util::now_ms(),
            }),
        };
        let accepted = match &request.custom_message {
            Some(_) => EngineEvent::CustomMessage(accepted_row.clone()),
            None => EngineEvent::UserMessage(accepted_row.clone()),
        };
        if !emit(accepted) {
            emit(cancelled());
            return;
        }
        // The batched co-delivery rows (the real engine's one-run batch):
        // one accepted user row per batched message, in delivery order —
        // images ride as multimodal content blocks after the text, like
        // the primary — ahead of the single scripted reply.
        let mut batch_rows = Vec::new();
        for row in &request.batch {
            let mut content = vec![json!({ "type": "text", "text": row.text })];
            for image in &row.images {
                let mut block = match serde_json::to_value(image) {
                    Ok(Value::Object(block)) => Value::Object(block),
                    _ => continue,
                };
                if let Some(object) = block.as_object_mut() {
                    object.insert("type".to_string(), json!("image"));
                }
                content.push(block);
            }
            let accepted_row = json!({
                "role": "user",
                "content": content,
                "timestamp": crate::util::now_ms(),
            });
            batch_rows.push(accepted_row.clone());
            if !emit(EngineEvent::UserMessage(accepted_row)) {
                emit(cancelled());
                return;
            }
        }
        // The fixture's mid-turn goal announcement (the real engine's
        // `goal_update` emission path, TS `_setGoalState` ->
        // `_emitGoalUpdate`).
        if let Some(goal) = self.goal.as_ref().filter(|goal| goal.emit_update_on_prompt) {
            if !emit(EngineEvent::GoalUpdate {
                goal: goal.state.clone(),
            }) {
                emit(cancelled());
                return;
            }
        }
        let usage = scripted_usage();
        if !emit(EngineEvent::AssistantUpdate {
            message: AssistantSnapshot::Wire(
                json!({"role": "assistant", "content": "", "provider": "scripted", "model": "faux-1", "usage": usage, "timestamp": crate::util::now_ms()}),
            ),
            stream_event: None,
        }) {
            emit(cancelled());
            return;
        }
        let scripted_tools = scripted
            .as_ref()
            .and_then(|response| response.get("toolCalls"))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        // The real engine's assistant message carries its tool calls as
        // `toolCall` content blocks (session stats count calls from them
        // and results from the `toolResult` rows); a plain response keeps
        // the text content unchanged.
        let final_message = if scripted_tools.is_empty() {
            json!({"role": "assistant", "content": text, "provider": "scripted", "model": "faux-1", "usage": usage, "timestamp": crate::util::now_ms()})
        } else {
            let mut content = vec![json!({ "type": "text", "text": text })];
            for call in &scripted_tools {
                if call.get("toolCallId").and_then(Value::as_str).is_some() {
                    content.push(json!({
                        "type": "toolCall",
                        "id": call.get("toolCallId").cloned().unwrap_or(Value::Null),
                        "name": call.get("toolName").cloned().unwrap_or(json!("scripted_tool")),
                        "arguments": call.get("args").cloned().unwrap_or(Value::Null),
                    }));
                }
            }
            json!({"role": "assistant", "content": content, "provider": "scripted", "model": "faux-1", "usage": usage, "timestamp": crate::util::now_ms()})
        };
        if !emit(EngineEvent::AssistantMessage(final_message.clone())) {
            emit(cancelled());
            return;
        }
        // The scripted tool calls (the real loop's tool-call lifecycle, in
        // event order): each entry emits `tool_execution_start`, then
        // `tool_execution_end` with its settled result, then the
        // `toolResult` message the session file records (the roster
        // activity feed keys its `isRunningTools` flag on these frames).
        let mut tool_results = Vec::with_capacity(scripted_tools.len());
        for call in scripted_tools {
            let Some(tool_call_id) = call.get("toolCallId").and_then(Value::as_str) else {
                continue;
            };
            let tool_call_id = tool_call_id.to_string();
            let tool_name = call
                .get("toolName")
                .and_then(Value::as_str)
                .unwrap_or("scripted_tool")
                .to_string();
            let is_error = call
                .get("isError")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let result_text = call.get("result").cloned().unwrap_or(Value::Null);
            if !emit(EngineEvent::ToolExecutionStart {
                tool_call_id: tool_call_id.clone(),
                tool_name: tool_name.clone(),
                args: call.get("args").cloned().unwrap_or(Value::Null),
            }) {
                emit(cancelled());
                return;
            }
            // A running tool holds the turn for its scripted duration (the
            // real loop waits on the tool): the roster activity feed
            // composes and ships a delta while the tool executes, so the
            // gap must outlast the feed's round trip.
            if let Some(delay) = call.get("delayMs").and_then(Value::as_u64) {
                if delay > 0 {
                    std::thread::sleep(std::time::Duration::from_millis(delay));
                }
            }
            if !emit(EngineEvent::ToolExecutionEnd {
                tool_call_id: tool_call_id.clone(),
                result: json!({
                    "content": [{ "type": "text", "text": result_text.clone() }],
                    "details": Value::Null,
                    "isError": is_error,
                }),
                is_error,
            }) {
                emit(cancelled());
                return;
            }
            let result_message = json!({
                "role": "toolResult",
                "toolCallId": tool_call_id,
                "toolName": tool_name,
                "content": [{ "type": "text", "text": result_text }],
                "isError": is_error,
                "timestamp": crate::util::now_ms(),
            });
            if !emit(EngineEvent::ToolResultMessage(result_message.clone())) {
                emit(cancelled());
                return;
            }
            tool_results.push(result_message);
        }
        // The loop's terminal frame (TS `turn_end`): the final assistant
        // message as the payload, the scripted tool results riding it.
        if !emit(EngineEvent::TurnEnd {
            message: final_message.clone(),
            tool_results: tool_results.clone(),
        }) {
            emit(cancelled());
            return;
        }
        // The loop's run-end frame (TS `agent_end`): the run's
        // accumulated message set — the accepted rows (the primary plus
        // every batched row), the final assistant message, and every tool
        // result in the scripted shape.
        let mut run_messages = vec![accepted_row];
        run_messages.extend(batch_rows);
        run_messages.push(final_message);
        run_messages.extend(tool_results);
        if !emit(EngineEvent::AgentEnd {
            messages: run_messages,
        }) {
            emit(cancelled());
            return;
        }
        emit(EngineEvent::Done(Ok(())));
    }

    fn run_side_question(
        &self,
        request: SideQuestionRequest,
        signal: &AbortSignal,
        sink: &SideQuestionSink,
    ) -> SideQuestionOutcome {
        use pa_core::session_engine::provider_retry::{
            complete_with_provider_retry, DEFAULT_PROVIDER_RETRY_POLICY,
        };
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc as StdArc;

        // Unscripted side questions echo, like the prompt fallback.
        if self.side_question.responses.is_empty() {
            let answer = format!("echo: {}", request.question);
            if signal.is_aborted() || !sink(&answer) {
                return SideQuestionOutcome::Aborted { answer };
            }
            return SideQuestionOutcome::Complete { answer };
        }

        let policy = self
            .side_question
            .retry
            .clone()
            .unwrap_or(DEFAULT_PROVIDER_RETRY_POLICY);
        // Every scripted side-question run replays its results from the top,
        // like a fresh side conversation per run.
        let responses = StdArc::new(self.side_question.responses.clone());
        let attempt_index = StdArc::new(AtomicUsize::new(0));
        let sink = StdArc::clone(sink);
        let signal = signal.clone();
        let wait_signal = signal.clone();
        let attempt_signal = signal.clone();
        let result = futures::executor::block_on(complete_with_provider_retry(
            &policy,
            Some(&signal),
            move |delay| {
                let wait_signal = wait_signal.clone();
                async move { abortable_sleep(delay, &|| wait_signal.is_aborted()) }
            },
            move || {
                let responses = StdArc::clone(&responses);
                let attempt_index = StdArc::clone(&attempt_index);
                let sink = StdArc::clone(&sink);
                let signal = attempt_signal.clone();
                async move {
                    let index = attempt_index.fetch_add(1, Ordering::SeqCst);
                    let Some(entry) = responses.get(index) else {
                        anyhow::bail!("No more scripted side-question responses");
                    };
                    Ok(scripted_side_question_turn(entry, &sink, &signal))
                }
            },
        ));
        let failed = |answer: String, error: String| SideQuestionOutcome::Failed { answer, error };
        match result {
            Ok(message) => {
                let text = match &message.content[0] {
                    pa_agent::types::AssistantContent::Text(text) => text.text.clone(),
                    _ => String::new(),
                };
                match message.stop_reason {
                    pa_agent::types::StopReason::Stop => {
                        SideQuestionOutcome::Complete { answer: text }
                    }
                    pa_agent::types::StopReason::Aborted => {
                        SideQuestionOutcome::Aborted { answer: text }
                    }
                    _ => failed(
                        text,
                        message
                            .error_message
                            .unwrap_or_else(|| "Side question failed".to_string()),
                    ),
                }
            }
            Err(error) => failed(String::new(), error.to_string()),
        }
    }
    fn run_compaction(
        &self,
        _request: CompactionRequest,
        signal: &AbortSignal,
    ) -> CompactionOutcome {
        // Unscripted compactions produce a deterministic result, like the
        // prompt echo fallback. Scripted runs consume entries in order and
        // replay from the top once exhausted.
        let Some(entry) = (|| {
            let index = self
                .compaction
                .next
                .fetch_update(
                    std::sync::atomic::Ordering::SeqCst,
                    std::sync::atomic::Ordering::SeqCst,
                    |current| {
                        Some(if current + 1 >= self.compaction.responses.len() {
                            0
                        } else {
                            current + 1
                        })
                    },
                )
                .ok()?;
            self.compaction.responses.get(index)
        })() else {
            return CompactionOutcome::Compacted {
                run: Box::new(CompactionRun {
                    result: json!({
                        "summary": "scripted compaction summary",
                        "firstKeptEntryId": "",
                        "tokensBefore": 0,
                        "details": { "readFiles": [], "modifiedFiles": [] },
                    }),
                    usage: None,
                    entry: Value::Null,
                    ipython_state: None,
                }),
            };
        };
        if let Some(error) = entry.get("error").and_then(Value::as_str) {
            return if entry.get("skipped").and_then(Value::as_bool) == Some(true) {
                CompactionOutcome::Skipped {
                    message: error.to_string(),
                }
            } else {
                CompactionOutcome::Failed {
                    error: error.to_string(),
                }
            };
        }
        let delay_ms = Self::response_delay_ms(entry);
        if delay_ms > 0
            && !abortable_sleep(std::time::Duration::from_millis(delay_ms), &|| {
                signal.is_aborted()
            })
        {
            return CompactionOutcome::Aborted;
        }
        if signal.is_aborted() {
            return CompactionOutcome::Aborted;
        }
        let result = json!({
            "summary": entry.get("summary").and_then(Value::as_str).unwrap_or_default(),
            "firstKeptEntryId": entry.get("firstKeptEntryId").and_then(Value::as_str).unwrap_or_default(),
            "tokensBefore": entry.get("tokensBefore").and_then(Value::as_u64).unwrap_or_default(),
            "details": entry.get("details").cloned().unwrap_or_else(|| json!({
                "readFiles": [], "modifiedFiles": [],
            })),
        });
        CompactionOutcome::Compacted {
            run: Box::new(CompactionRun {
                result,
                usage: entry.get("usage").cloned().filter(|usage| !usage.is_null()),
                entry: Value::Null,
                ipython_state: None,
            }),
        }
    }

    fn run_branch_summary(
        &self,
        _request: BranchSummaryRequest,
        signal: &AbortSignal,
    ) -> BranchSummaryOutcome {
        // Unscripted branch summaries produce a deterministic result, like
        // the compaction fallback. Scripted runs consume entries in order
        // and replay from the top once exhausted.
        let Some(entry) = (|| {
            let index = self
                .branch_summary
                .next
                .fetch_update(
                    std::sync::atomic::Ordering::SeqCst,
                    std::sync::atomic::Ordering::SeqCst,
                    |current| {
                        Some(if current + 1 >= self.branch_summary.responses.len() {
                            0
                        } else {
                            current + 1
                        })
                    },
                )
                .ok()?;
            self.branch_summary.responses.get(index)
        })() else {
            return BranchSummaryOutcome::Complete {
                run: BranchSummaryRun {
                    summary: "scripted branch summary".to_string(),
                    usage: None,
                    details: Some(json!({ "readFiles": [], "modifiedFiles": [] })),
                    model: None,
                },
            };
        };
        if let Some(error) = entry.get("error").and_then(Value::as_str) {
            return BranchSummaryOutcome::Failed {
                error: error.to_string(),
            };
        }
        let delay_ms = Self::response_delay_ms(entry);
        if delay_ms > 0
            && !abortable_sleep(std::time::Duration::from_millis(delay_ms), &|| {
                signal.is_aborted()
            })
        {
            return BranchSummaryOutcome::Aborted;
        }
        if signal.is_aborted() {
            return BranchSummaryOutcome::Aborted;
        }
        BranchSummaryOutcome::Complete {
            run: BranchSummaryRun {
                summary: entry
                    .get("summary")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                usage: entry.get("usage").cloned().filter(|usage| !usage.is_null()),
                details: entry.get("details").cloned().filter(|d| !d.is_null()),
                model: (|| {
                    let provider = entry.get("provider")?.as_str()?.to_string();
                    let model_id = entry.get("modelId")?.as_str()?.to_string();
                    Some((provider, model_id))
                })(),
            },
        }
    }

    fn rebuild_session_context(
        &self,
        _branch_entries: Vec<pa_types::session::FileEntry>,
        _goal_reload: pa_core::session_engine::goal_driver::GoalBranchReload,
    ) -> Result<()> {
        // The scripted harness engine carries no durable model context.
        Ok(())
    }
}

/// Scripted side-question turn statuses ride the assistant message's stop
/// reason; text blocks carry the (partial) answer.
fn scripted_side_question_turn(
    entry: &Value,
    sink: &SideQuestionSink,
    signal: &AbortSignal,
) -> pa_agent::types::AssistantMessage {
    use pa_agent::types::{
        AssistantContent, AssistantMessage, AssistantMessageDiagnostic, StopReason, TextContent,
    };
    let base = || AssistantMessage {
        content: vec![AssistantContent::Text(TextContent {
            text: String::new(),
            text_signature: None,
        })],
        api: String::new(),
        provider: "scripted".to_string(),
        model: "faux-1".to_string(),
        response_model: None,
        response_id: None,
        diagnostics: None,
        usage: pa_agent::types::Usage::zero(),
        stop_reason: StopReason::Stop,
        stop_reason_raw: None,
        error_message: None,
        timestamp: 0,
    };
    let mut message = base();
    let set_text = |message: &mut AssistantMessage, text: &str| {
        let AssistantContent::Text(block) = &mut message.content[0] else {
            return;
        };
        block.text = text.to_string();
    };
    let text = ScriptedEngine::response_text(entry);
    if let Some(error) = entry.get("error").and_then(Value::as_str) {
        // Scripted provider failure with structured classification, so the
        // shared retry policy sees the same details a real provider records.
        let kind = entry.get("kind").and_then(Value::as_str);
        let status = entry.get("status").and_then(Value::as_u64);
        let retry_after_ms = entry.get("retryAfterMs").and_then(Value::as_u64);
        message.stop_reason = StopReason::Error;
        message.error_message = Some(error.to_string());
        message.diagnostics = Some(vec![AssistantMessageDiagnostic {
            kind: "provider_stream_failure".to_string(),
            timestamp: 0,
            error: None,
            details: Some(json!({
                "kind": kind,
                "status": status,
                "retryAfterMs": retry_after_ms,
            })),
        }]);
        return message;
    }
    // Stream the partial answer, then wait the scripted delay abortably.
    if signal.is_aborted() || !sink(&text) {
        set_text(&mut message, &text);
        message.stop_reason = StopReason::Aborted;
        return message;
    }
    let delay_ms = ScriptedEngine::response_delay_ms(entry);
    if delay_ms > 0
        && !abortable_sleep(std::time::Duration::from_millis(delay_ms), &|| {
            signal.is_aborted()
        })
    {
        set_text(&mut message, &text);
        message.stop_reason = StopReason::Aborted;
        return message;
    }
    if signal.is_aborted() {
        set_text(&mut message, &text);
        message.stop_reason = StopReason::Aborted;
        return message;
    }
    set_text(&mut message, &text);
    message
}

/// Sleep `delay` in slices, stopping early when `aborted` turns true.
/// Returns `false` when the wait ended aborted.
fn abortable_sleep(delay: std::time::Duration, aborted: &dyn Fn() -> bool) -> bool {
    let mut remaining = delay;
    while !remaining.is_zero() {
        if aborted() {
            return false;
        }
        let slice = remaining.min(std::time::Duration::from_millis(25));
        std::thread::sleep(slice);
        remaining = remaining.saturating_sub(slice);
    }
    !aborted()
}
