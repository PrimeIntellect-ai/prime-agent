//! The turn-boundary host-request surface: `model.info`, `compact.*`, and
//! `refine.*`, reached by the kernel-side skill modules through `rlm.host_request`.
//! `compact.run`/`refine.run` only SCHEDULE: executing inside the active turn
//! would abort the requesting run, so the pending request is stored here.

use std::sync::Arc;

use pa_agent::agent::Agent;
use pa_types::session::FileEntry;
use serde_json::{json, Value};
use tokio::sync::Mutex;

use crate::kernel::shared::{host_handler, HostRequestHandlers};
use crate::session::manager::SessionManager;

use pa_types::usage::{calculate_context_tokens, estimate_tokens, valid_assistant_usage};

use super::compact_session::{prepare_compaction, CompactSkip};
use super::engine::SessionEngine;

/// A scheduled compaction (kernel `compact.run`).
#[derive(Debug, Clone, PartialEq)]
pub struct PendingCompaction {
    pub instructions: Option<String>,
}

/// A scheduled refinement (kernel `refine.run`).
#[derive(Debug, Clone, PartialEq)]
pub struct PendingRefine {
    pub instructions: Option<String>,
    pub global: bool,
}

/// The model facts `model.info` reports (TS answers nulls when the session
/// has no model; the Rust engine always resolves one).
#[derive(Debug, Clone, PartialEq)]
pub struct ModelInfo {
    pub id: String,
    pub provider: String,
    /// Input modalities (empty when the resolved model did not declare
    /// any, e.g. harness-converted minimal models).
    pub input: Vec<pa_types::ai::ModelInput>,
}

/// The runtime the handlers read once the session is assembled;
/// `create_session` binds this before returning.
pub struct TurnBoundaryRuntime {
    pub agent: Arc<Agent>,
    pub session: Arc<Mutex<SessionManager>>,
    /// The resolved model's context window; `None` when unknown (compact
    /// status answers null tokens then).
    pub context_window: Option<u64>,
    pub model_info: ModelInfo,
}

/// Estimated context usage (TS `getContextUsage`): the last valid assistant
/// usage plus trailing message estimates; `tokens`/`percent` are `None`
/// right after a compaction without a usable post-compaction usage.
#[derive(Debug, Clone, PartialEq)]
pub struct ContextUsage {
    pub tokens: Option<u64>,
    pub context_window: u64,
    pub percent: Option<f64>,
}

/// The turn-boundary state: pending requests plus the late-bound runtime,
/// shared between the host bridge and the turn loop; build it in `Arc` form.
#[derive(Default)]
pub struct TurnBoundaryRequests {
    /// The late-bound runtime; `bind` is first-wins, and `rebind_model_facts`
    /// swaps the model facts after a live model switch.
    runtime: std::sync::RwLock<Option<Arc<TurnBoundaryRuntime>>>,
    compaction: Mutex<Option<PendingCompaction>>,
    refine: Mutex<Option<PendingRefine>>,
}

impl TurnBoundaryRequests {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Bind the assembled session runtime (first bind wins).
    pub fn bind(&self, runtime: TurnBoundaryRuntime) {
        let mut cell = self
            .runtime
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if cell.is_none() {
            *cell = Some(Arc::new(runtime));
        }
    }

    /// `None` until the session is assembled.
    pub fn bound(&self) -> Option<Arc<TurnBoundaryRuntime>> {
        self.runtime
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    /// Re-bind the model facts after a live model switch (the agent and
    /// session cells stay).
    pub fn rebind_model_facts(&self, model_info: ModelInfo, context_window: Option<u64>) {
        let Some(current) = self.bound() else {
            return;
        };
        let updated = TurnBoundaryRuntime {
            agent: Arc::clone(&current.agent),
            session: Arc::clone(&current.session),
            context_window,
            model_info,
        };
        *self
            .runtime
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(Arc::new(updated));
    }

    /// Take the pending compaction (the turn boundary consumes it once).
    pub async fn take_compaction(&self) -> Option<PendingCompaction> {
        self.compaction.lock().await.take()
    }

    /// Schedule a compaction for the next turn boundary: the request's
    /// instructions win, an absent one keeps what was already scheduled.
    pub async fn schedule_compaction(&self, instructions: Option<String>) {
        let mut slot = self.compaction.lock().await;
        let merged = PendingCompaction {
            instructions: instructions.or_else(|| {
                slot.as_ref()
                    .and_then(|current| current.instructions.clone())
            }),
        };
        *slot = Some(merged);
    }

    /// Whether a compaction is scheduled (TS `compact.status` `scheduled`).
    pub async fn compaction_scheduled(&self) -> bool {
        self.compaction.lock().await.is_some()
    }

    /// The scheduled compaction without consuming it (the consumer
    /// announces the run with the pending instructions first).
    pub async fn scheduled_compaction(&self) -> Option<PendingCompaction> {
        self.compaction.lock().await.clone()
    }

    /// Take the pending refinement (the turn boundary consumes it once).
    pub async fn take_refine(&self) -> Option<PendingRefine> {
        self.refine.lock().await.take()
    }

    /// Schedule a refinement for the next turn boundary; the caller owns the
    /// merge contract (an absent field keeps the pending request's value).
    pub async fn schedule_refine(&self, pending: PendingRefine) {
        *self.refine.lock().await = Some(pending);
    }

    /// Drop both pending requests (an aborted turn never services them;
    /// a stale request must not leak into the next turn).
    pub async fn clear_pending(&self) {
        *self.compaction.lock().await = None;
        *self.refine.lock().await = None;
    }

    /// Whether a refinement is queued (TS `refine.status` `pending`).
    pub async fn refine_pending(&self) -> bool {
        self.refine.lock().await.is_some()
    }

    /// Register `model.info` (always present, like the TS `_hostHandlers`
    /// default map).
    pub fn register_model_info_handler(
        self: &Arc<Self>,
        handlers: &mut HostRequestHandlers,
        model_info: ModelInfo,
    ) {
        // Weak: the kernel holds these handlers for its whole life, so a
        // strong capture here loops the ownership graph and pins a dropped
        // session's kernel process until exit.
        let requests = Arc::downgrade(self);
        handlers.register(
            "model.info",
            host_handler(move |_payload| {
                let requests = requests.clone();
                let model_info = model_info.clone();
                Box::pin(async move {
                    // The bound runtime is authoritative once live; the
                    // registration-time facts cover pre-bind probes and a
                    // dropped session (model.info always answers).
                    let model_info = requests
                        .upgrade()
                        .and_then(|requests| {
                            requests.bound().map(|runtime| runtime.model_info.clone())
                        })
                        .unwrap_or(model_info);
                    Ok(json!({
                        "id": model_info.id,
                        "provider": model_info.provider,
                        "input": model_info.input.iter().map(|input| match input {
                            pa_types::ai::ModelInput::Text => "text",
                            pa_types::ai::ModelInput::Image => "image",
                        }).collect::<Vec<&str>>(),
                    }))
                })
            }),
        );
    }

    /// Register `compact.status`/`compact.run`, gated by the compaction `agentCallable`
    /// setting; `create_session` passes the resolved keep-recent budget.
    pub fn register_compact_handlers(
        self: &Arc<Self>,
        handlers: &mut HostRequestHandlers,
        keep_recent_tokens: u64,
    ) {
        let requests = Arc::downgrade(self);
        handlers.register(
            "compact.status",
            host_handler(move |_payload| {
                let requests = requests.clone();
                Box::pin(async move {
                    let Some(requests) = requests.upgrade() else {
                        return Err(anyhow::anyhow!(
                            "the session ended before the request could be served"
                        ));
                    };
                    let usage = match requests.bound() {
                        Some(runtime) => {
                            let entries = runtime.session.lock().await.retained_entries().to_vec();
                            context_usage(&entries, runtime.context_window)
                        }
                        None => None,
                    };
                    let scheduled = requests.compaction_scheduled().await;
                    let (tokens, window, percent) = match usage {
                        Some(usage) => (
                            usage.tokens.map_or(Value::Null, Value::from),
                            Value::from(usage.context_window),
                            usage.percent.map_or(Value::Null, Value::from),
                        ),
                        None => (Value::Null, Value::Null, Value::Null),
                    };
                    Ok(json!({
                        "tokens": tokens,
                        "context_window": window,
                        "percent": percent,
                        "scheduled": scheduled,
                    }))
                })
            }),
        );
        let requests = Arc::downgrade(self);
        handlers.register(
            "compact.run",
            host_handler(move |payload| {
                let requests = requests.clone();
                Box::pin(async move {
                    let Some(requests) = requests.upgrade() else {
                        return Err(anyhow::anyhow!("the session ended before the request could be served"));
                    };
                    let instructions = string_field(
                        &payload.data,
                        "instructions",
                        "compact.run instructions must be a string when provided",
                    )?;
                    let Some(runtime) = requests.bound() else {
                        return Ok(no_active_turn(
                            "no active turn; compaction can only be requested while a turn is running",
                        ));
                    };
                    let state = runtime.agent.state().await;
                    if !state.is_streaming {
                        return Ok(no_active_turn(
                            "no active turn; compaction can only be requested while a turn is running",
                        ));
                    }
                    // TS `prepareCompaction`: only schedule a compaction
                    // that has history to summarize.
                    let entries = runtime.session.lock().await.retained_entries().to_vec();
                    if let Some(reason) =
                        compaction_request_skip_reason(&entries, keep_recent_tokens)
                    {
                        return Ok(json!({ "scheduled": false, "reason": reason }));
                    }
                    requests.schedule_compaction(instructions).await;
                    Ok(json!({
                        "scheduled": true,
                        "note": "Compaction runs when the current turn ends; you resume automatically afterwards. Continue working normally.",
                    }))
                })
            }),
        );
    }

    /// Register `refine.status`/`refine.run`, gated by the depth-0-with-
    /// local-harness-dir equivalent; `create_session` decides.
    pub fn register_refine_handlers(self: &Arc<Self>, handlers: &mut HostRequestHandlers) {
        let requests = Arc::downgrade(self);
        handlers.register(
            "refine.status",
            host_handler(move |_payload| {
                let requests = requests.clone();
                Box::pin(async move {
                    let Some(requests) = requests.upgrade() else {
                        return Err(anyhow::anyhow!(
                            "the session ended before the request could be served"
                        ));
                    };
                    let pending = requests.refine_pending().await;
                    // The Rust consumption runs refinement synchronously
                    // between turns, so a cell never observes it in flight
                    // (the TS background-planning path is not ported).
                    Ok(json!({ "pending": pending, "in_flight": false }))
                })
            }),
        );
        let requests = Arc::downgrade(self);
        handlers.register(
            "refine.run",
            host_handler(move |payload| {
                let requests = requests.clone();
                Box::pin(async move {
                    let Some(requests) = requests.upgrade() else {
                        return Err(anyhow::anyhow!("the session ended before the request could be served"));
                    };
                    let instructions = string_field(
                        &payload.data,
                        "instructions",
                        "refine.run instructions must be a string when provided",
                    )?;
                    let global = match payload.data.get("global") {
                        None | Some(Value::Null) => None,
                        Some(Value::Bool(value)) => Some(*value),
                        Some(_) => anyhow::bail!(
                            "refine.run global must be a boolean when provided"
                        ),
                    };
                    let Some(runtime) = requests.bound() else {
                        return Ok(no_active_turn(
                            "no active turn; refine can only be requested while a turn is running",
                        ));
                    };
                    let state = runtime.agent.state().await;
                    if !state.is_streaming {
                        return Ok(no_active_turn(
                            "no active turn; refine can only be requested while a turn is running",
                        ));
                    }
                    let mut slot = requests.refine.lock().await;
                    let merged = match slot.as_ref() {
                        Some(current) => PendingRefine {
                            instructions: instructions
                                .or_else(|| current.instructions.clone()),
                            global: global.unwrap_or(current.global),
                        },
                        None => PendingRefine {
                            instructions,
                            global: global.unwrap_or(false),
                        },
                    };
                    *slot = Some(merged);
                    Ok(json!({
                        "scheduled": true,
                        "note": "Refinement runs when the current turn ends; applied edits are appended to your context as a refinement notice and you resume automatically. Continue working normally.",
                    }))
                })
            }),
        );
    }
}

/// One turn-boundary consumption: the outcomes the host runtime persists and broadcasts;
/// `Err` rows surface like the TS failed-compaction / `refine_failed` events.
#[derive(Debug)]
pub struct TurnBoundaryConsumption {
    pub compaction: Option<anyhow::Result<super::compact_session::CompactOutcome>>,
    pub refinement: Option<anyhow::Result<crate::refinement::RefinementResult>>,
}

impl SessionEngine {
    /// Consume a pending model-requested compaction at a turn boundary; taken regardless
    /// of outcome, so a failed run is not silently re-run. `abort` cancels the run,
    /// surfacing the abort marker error the consumer maps to its cancelled outcome.
    pub async fn consume_pending_compaction(
        &self,
        model: &pa_types::ai::Model,
        api_key: Option<String>,
        abort: Option<&pa_agent::abort::AbortSignal>,
    ) -> Option<anyhow::Result<super::compact_session::CompactOutcome>> {
        let pending = self.turn_boundary.take_compaction().await?;
        let compact = async {
            self.session
                .compact(pending.instructions.as_deref(), model, api_key, abort)
                .await
        };
        Some(match abort {
            // The refinement is not raced — TS `abortCompaction` never
            // aborts it.
            Some(signal) => match pa_agent::abort::race_with_abort(compact, signal).await {
                Ok(inner) => inner,
                Err(error) => Err(error),
            },
            None => compact.await,
        })
    }

    /// Consume a pending model-requested refinement at a turn boundary;
    /// taken regardless of outcome, so a failed run is not silently re-run.
    pub async fn consume_pending_refinement(
        &self,
        model: &pa_types::ai::Model,
        api_key: Option<String>,
        global_harness_dir: std::path::PathBuf,
    ) -> Option<anyhow::Result<crate::refinement::RefinementResult>> {
        let pending = self.turn_boundary.take_refine().await?;
        let options = super::refine::RefineOptions {
            global: pending.global,
            instructions: pending.instructions,
            rollback_id: None,
        };
        Some(
            self.session
                .refine(
                    &options,
                    super::refine::RefinementSource::SelfRefine,
                    model,
                    api_key,
                    global_harness_dir,
                )
                .await,
        )
    }

    /// Consume pending turn-boundary requests after a settled turn: compaction
    /// first, then refinement; the pieces are exposed separately for hosts that
    /// mirror the TS sequencing (the overflow arm interleaves).
    pub async fn consume_turn_boundary_requests(
        &self,
        model: &pa_types::ai::Model,
        api_key: Option<String>,
        global_harness_dir: std::path::PathBuf,
        abort: Option<&pa_agent::abort::AbortSignal>,
    ) -> TurnBoundaryConsumption {
        let mut consumption = TurnBoundaryConsumption {
            compaction: None,
            refinement: None,
        };
        consumption.compaction = self
            .consume_pending_compaction(model, api_key.clone(), abort)
            .await;
        consumption.refinement = self
            .consume_pending_refinement(model, api_key, global_harness_dir)
            .await;
        consumption
    }
}

/// An optional string field with the exact TS validation message on a
/// non-string value; `None` for absent/null.
fn string_field(data: &Value, key: &str, error: &'static str) -> anyhow::Result<Option<String>> {
    match data.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => Ok(Some(value.clone())),
        Some(_) => anyhow::bail!("{error}"),
    }
}

/// The `{ scheduled: false, reason }` give-up shape.
fn no_active_turn(reason: &'static str) -> Value {
    json!({ "scheduled": false, "reason": reason })
}

/// The `compact.run` reason for a session that cannot prepare a
/// compaction, distinct from the `/compact` skip message.
fn compaction_request_skip_reason(
    entries: &[FileEntry],
    keep_recent_tokens: u64,
) -> Option<&'static str> {
    prepare_compaction(entries, keep_recent_tokens)
        .err()
        .map(CompactSkip::request_reason)
}

/// Estimated context usage: the last valid assistant usage anchors the
/// estimate; messages after it use the chars/4 heuristic. `None` when
/// the context window is unknown; `tokens`/`percent` `None` right
/// after a compaction without a usable post-compaction usage.
///
/// # Panics
///
/// The `expect` on the anchoring usage cannot fire: the index came from a
/// search restricted to messages with a valid usage.
pub fn context_usage(entries: &[FileEntry], context_window: Option<u64>) -> Option<ContextUsage> {
    let context_window = context_window.filter(|window| *window > 0)?;

    // Only usage from an assistant that responded after the latest
    // compaction boundary is trustworthy.
    if let Some(compaction_index) = entries
        .iter()
        .rposition(|entry| matches!(entry, FileEntry::Compaction { .. }))
    {
        let post_compaction_usage = entries[compaction_index + 1..]
            .iter()
            .filter_map(message_value)
            .find_map(|message| valid_assistant_usage(&message));
        let usable =
            post_compaction_usage.is_some_and(|usage| calculate_context_tokens(&usage) > 0);
        if !usable {
            return Some(ContextUsage {
                tokens: None,
                context_window,
                percent: None,
            });
        }
    }

    let messages: Vec<Value> = entries.iter().filter_map(message_value).collect();
    let mut tokens = 0u64;
    match messages
        .iter()
        .rposition(|message| valid_assistant_usage(message).is_some())
    {
        Some(last_usage_index) => {
            let usage = valid_assistant_usage(&messages[last_usage_index]).expect("checked");
            tokens += calculate_context_tokens(&usage);
            tokens += messages[last_usage_index + 1..]
                .iter()
                .map(estimate_tokens)
                .sum::<u64>();
        }
        None => {
            tokens += messages.iter().map(estimate_tokens).sum::<u64>();
        }
    }
    let percent = tokens as f64 / context_window as f64 * 100.0;
    Some(ContextUsage {
        tokens: Some(tokens),
        context_window,
        percent: Some(percent),
    })
}

/// A message entry as raw JSON (the shared usage helpers read the wire shape).
fn message_value(entry: &FileEntry) -> Option<Value> {
    match entry {
        FileEntry::Message { message, .. } => serde_json::to_value(message).ok(),
        _ => None,
    }
}

#[cfg(test)]
mod tests;
