//! Per-request phase timing for provider requests (TS #2462, port of
//! `packages/coding-agent/src/core/request-timing.ts`).
//!
//! Answers "what is the agent waiting for" when the TUI sits in `Waiting`
//! before the first reasoning/text token appears: the wait is split into
//! client-side phases (turn dispatch -> prompt-built -> request-sent) and
//! wire/server phases (request-sent -> first-byte covers request body
//! serialization, upload, and provider TTFB). A long request-sent ->
//! first-byte gap with a normal server-side TTFT points at slow upload or
//! provider prefill/prompt-cache miss rather than client work, and the
//! stream-done summary carries the final usage so a cache miss shows as
//! cacheRead ~ 0 with cacheWrite ~ the full prompt.
//!
//! Enable with `PI_REQUEST_TIMING=1` (env, inherited by daemon workers) or
//! `"requestTiming": true` in settings.json. Entries go to the shared JSONL
//! diagnostic log (`<agentDir>/logs/agent.jsonl`, TS `~/.prime/agent/logs/
//! agent.jsonl`) under the component `coding-agent.request-timing`. The TS
//! entries reach that file through the process-wide `getLogger` sink; the
//! Rust engine has no process-wide sink yet, so [`RequestTimingLog`] ports
//! the sink surface this feature needs (one JSON object per line, `ts`/
//! `level`/`component`/`msg`/`pid` reserved keys, rotation at the TS cap).
//!
//! Zero overhead when disabled: the wrappers pass straight through with no
//! timestamps, no payload serialization, and no log entries.
//!
//! Correlation mapping: TS keys the dispatch timestamp by the context array
//! and the prompt-build timing by the fresh per-turn LLM messages array
//! (`WeakMap`s, identity-keyed). The Rust loop moves those arrays by value,
//! so the prompt-build entry carries the built array's buffer address and
//! the stream seam consumes it only on an identity match — the loop's
//! move preserves the address, a cloned stream seam without the paired
//! convert (the side-question runs) matches nothing, and each turn's
//! convert overwrites the slot. The dispatch mark is consumed on read;
//! concurrent sessions own distinct wirings and cannot collide.
//!
//! One-shot completion calls outside the agent loop (compaction,
//! branch-summary, refinement) call the provider directly and are not
//! instrumented, exactly like the TS reference.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use pa_agent::agent_loop::{ConvertToLlmFn, TransformContextFn};
use pa_agent::stream::{
    AssistantMessageEvent, ModelStream, OnPayloadHook, OnResponseHook, StreamFn,
    StreamRequestOptions,
};
use pa_agent::types::StopReason;
use serde_json::{json, Map, Value};

use crate::session::manager::format_iso;

// The inline unit battery moved to the child module at the same tree
// position (session_engine::request_timing::tests); its use-super glob
// keeps resolving through the facade bindings and re-exports (the
// manager stage-1 precedent, #3039).
#[cfg(test)]
mod tests;

// The per-request clock concern (the request identity + usage records,
// the outcome + timing state machine, and the phase entries' emit) moved
// to the child module at the same tree position
// (session_engine::request_timing::clock); the resident StreamFn seam
// keeps its Outcome + RequestTiming references and its eight method calls
// (new + the mark/record/emit arms) in scope through the TEN pub(super)
// bumps (the only cross-seam callers - the caller map); the
// impl From<&Usage> for TimingUsage moves WHOLE with its type (E0119
// n/a); the child's bare calls into the facade's wiring/log/correlation
// machinery resolve through the use-super glob; the facade's
// pa_agent::types use row drops Usage (its only user moved - the child
// binds its own).
mod clock;
mod payload;
use clock::{Outcome, RequestTiming};
pub(crate) use payload::RequestPayloadCapture;

/// TS `REQUEST_TIMING_ENV`: the env override (inherited by daemon workers).
const REQUEST_TIMING_ENV: &str = "PI_REQUEST_TIMING";

/// TS log component: `getLogger("coding-agent.request-timing")`.
const LOG_COMPONENT: &str = "coding-agent.request-timing";

/// TS `AGENT_LOG_MAX_BYTES` (`logging.ts`): the shared JSONL log rotates at
/// 20 MiB.
const AGENT_LOG_MAX_BYTES: u64 = 20 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Flag
// ---------------------------------------------------------------------------

/// Whether request timing is on, evaluated per request so the flag can
/// change without a restart (TS `RequestTimingEnabled`). The settings half
/// is captured when the session wires its seams; the env half stays live.
pub type RequestTimingEnabled = Arc<dyn Fn() -> bool + Send + Sync>;

/// Truthy follows the `PI_OFFLINE`/`PI_TIMING` convention: 1/true/yes (TS
/// `truthyEnvFlag`).
fn truthy_env_flag(value: Option<&str>) -> bool {
    let Some(value) = value else {
        return false;
    };
    let normalized = value.to_ascii_lowercase();
    normalized == "1" || normalized == "true" || normalized == "yes"
}

/// Request timing is on when either the settings flag or the env override
/// is set (TS `isRequestTimingEnabled`). Both checks are cheap on the
/// disabled path.
#[must_use]
pub fn is_request_timing_enabled(settings_flag: bool) -> bool {
    settings_flag || truthy_env_flag(std::env::var(REQUEST_TIMING_ENV).ok().as_deref())
}

// ---------------------------------------------------------------------------
// Log
// ---------------------------------------------------------------------------

/// The shared JSONL diagnostic log request-timing entries go to (TS
/// `getLogger` entries land in `<agentDir>/logs/agent.jsonl`). One JSON
/// object per line; writes are best-effort and size-bounded, and logging
/// must never throw into the caller.
#[derive(Debug, Clone)]
pub struct RequestTimingLog {
    path: PathBuf,
    max_bytes: u64,
}

impl RequestTimingLog {
    /// The log at `<agentDir>/logs/agent.jsonl` with the TS rotation cap.
    #[must_use]
    pub fn new(agent_dir: &Path) -> Self {
        Self {
            path: agent_dir.join("logs").join("agent.jsonl"),
            max_bytes: AGENT_LOG_MAX_BYTES,
        }
    }

    /// The log at an explicit path (tests).
    #[cfg(test)]
    fn at(path: impl Into<PathBuf>) -> Self {
        Self {
            path: path.into(),
            max_bytes: AGENT_LOG_MAX_BYTES,
        }
    }

    /// Info-level entry (TS `Logger.info`): caller fields first, the
    /// reserved keys (`ts`/`level`/`component`/`msg`) and the sink's `pid`
    /// context win so an entry can never be misclassified. The `ts` field
    /// is the ISO-8601 UTC timestamp (TS `new Date().toISOString()`),
    /// reused from the session manager's formatter.
    fn info(&self, msg: &str, fields: Map<String, Value>) {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default();
        let mut entry = fields;
        entry.insert("ts".to_string(), json!(format_iso(now.as_millis() as i64)));
        entry.insert("level".to_string(), json!("info"));
        entry.insert("component".to_string(), json!(LOG_COMPONENT));
        entry.insert("msg".to_string(), json!(msg));
        entry.insert("pid".to_string(), json!(std::process::id()));
        self.append_rotating_log(&format!("{}\n", Value::Object(entry)));
    }

    /// TS `appendRotatingLog`: create the directory, rotate to `.old` past
    /// the cap, append the line. Every failure is swallowed — a read-only
    /// or missing log dir must never break the operation being logged.
    fn append_rotating_log(&self, line: &str) {
        use std::io::Write;
        let append = || -> std::io::Result<()> {
            std::fs::create_dir_all(self.path.parent().unwrap_or_else(|| Path::new(".")))?;
            // Best-effort rotation: TS keeps appending rather than dropping
            // the log when the rotate fails (the rename above is the only
            // fallible half of its try/catch).
            let _ = self.rotate_if_needed();
            let mut file = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&self.path)?;
            file.write_all(line.as_bytes())?;
            file.flush()
        };
        if let Err(error) = append() {
            tracing::debug!(path = %self.path.display(), %error, "request-timing log append failed");
        }
    }

    fn rotate_if_needed(&self) -> std::io::Result<()> {
        let size = match std::fs::metadata(&self.path) {
            Ok(meta) => meta.len(),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(err) => return Err(err),
        };
        if size <= self.max_bytes {
            return Ok(());
        }
        // Drop any prior `.old` first: the rename fails on Windows if the
        // destination exists (TS does the same). A rotation failure keeps
        // appending rather than dropping the log.
        let rotated = self.path.with_extension("jsonl.old");
        let _ = std::fs::remove_file(&rotated);
        std::fs::rename(&self.path, &rotated)
    }
}

// ---------------------------------------------------------------------------
// Per-session correlation state
// ---------------------------------------------------------------------------

/// Correlation state recorded while the loop builds the request (TS
/// `PromptBuildTiming`); `request_seq` carries the per-request sequence
/// number the TS `WeakMap` stored beside it, and `messages_ptr` carries
/// the `WeakMap`'s key semantics: the built LLM message array's identity.
/// The loop moves that array by value into the stream call, so its buffer
/// address is the identity the stream seam matches on — a cloned stream
/// seam without the paired convert (the side-question runs) sees no match
/// and correlates nothing, exactly like the TS `WeakMap` lookup on a
/// never-marked array.
#[derive(Debug, Clone, Copy)]
struct PromptBuildTiming {
    /// Identity of the built LLM message array (its buffer address).
    messages_ptr: usize,
    /// Turn dispatch: the instrumented transform seam's entry (first seam
    /// of the turn).
    dispatched_at: Instant,
    /// After `convert_to_llm`: the LLM message array is built.
    prompt_built_at: Instant,
    /// LLM message count of the built prompt.
    context_entries: usize,
    /// Per-request sequence number, shared by every entry of one request.
    request_seq: u64,
}

/// Per-session timing state: the TS module-level `WeakMap`s (dispatch,
/// prompt build) and the request-sequence counter, bundled because the Rust
/// seams share one session wiring.
pub struct RequestTimingWiring {
    enabled: RequestTimingEnabled,
    log: RequestTimingLog,
    /// The outbound body capture; `None` captures nothing (the timeline
    /// stays at phases and byte counts).
    payload_capture: Option<RequestPayloadCapture>,
    dispatch: Mutex<Option<Instant>>,
    prompt_build: Mutex<Option<PromptBuildTiming>>,
    request_seq: AtomicU64,
}

impl RequestTimingWiring {
    /// New wiring: the enabled probe is evaluated per request, the log is
    /// the shared JSONL diagnostic log.
    pub fn new(enabled: RequestTimingEnabled, log: RequestTimingLog) -> Self {
        Self {
            enabled,
            log,
            payload_capture: None,
            dispatch: Mutex::new(None),
            prompt_build: Mutex::new(None),
            request_seq: AtomicU64::new(0),
        }
    }

    /// Arm the outbound body capture: while the flag is on, the
    /// instrumented payload hook hands each request's final body to the
    /// capture's bounded writer.
    #[must_use]
    pub(crate) fn with_payload_capture(mut self, capture: RequestPayloadCapture) -> Self {
        self.payload_capture = Some(capture);
        self
    }

    /// The JSONL log the entries go to.
    fn log(&self) -> &RequestTimingLog {
        &self.log
    }

    fn enabled(&self) -> bool {
        (self.enabled)()
    }

    /// TS `markRequestTimingDispatch`: the latest turn overwrites the
    /// previous entry (the loop reuses its context snapshot per run).
    fn mark_dispatch(&self, at: Instant) {
        *self
            .dispatch
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(at);
    }

    /// TS `takeRequestTimingDispatch`, with the `WeakMap`'s per-key lifetime:
    /// the mark is consumed by the first convert that reads it, so a later
    /// prompt build after a flag toggle never reuses a dead request's
    /// timestamp (a fresh array in TS holds no mark).
    fn take_dispatch(&self) -> Option<Instant> {
        self.dispatch
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take()
    }

    /// TS `takePromptBuild` with the `WeakMap`'s key identity: the entry is
    /// consumed only when the stream's LLM message array is the very array
    /// the convert built (moved by value through the loop, so the buffer
    /// address matches). A cloned stream seam without the paired convert —
    /// the side-question runs — sees no match, correlates nothing, and
    /// leaves the parent request's entry in place.
    fn take_prompt_build(&self, messages_ptr: usize) -> Option<PromptBuildTiming> {
        let mut slot = self
            .prompt_build
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        match *slot {
            Some(timing) if timing.messages_ptr == messages_ptr => slot.take(),
            _ => None,
        }
    }

    fn set_prompt_build(&self, timing: PromptBuildTiming) {
        *self
            .prompt_build
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(timing);
    }

    /// TS `nextRequestSeq`: 1-based, one number per request.
    fn next_request_seq(&self) -> u64 {
        self.request_seq.fetch_add(1, Ordering::Relaxed) + 1
    }
}

// ---------------------------------------------------------------------------
// Seam wrappers
// ---------------------------------------------------------------------------

/// The pass-through context transform (the Rust engine wires no context
/// transform): it exists so the instrumented seam can mark the turn's
/// dispatch moment.
#[must_use]
pub fn pass_through_transform() -> TransformContextFn {
    Arc::new(|messages, _signal| Box::pin(async move { Ok(messages) }))
}

/// TS `instrumentTransformContext`: instruments the agent-loop
/// `transformContext` seam — the entry timestamp is the request's
/// "send-received" moment (turn dispatch).
pub fn instrument_transform_context(
    wiring: Arc<RequestTimingWiring>,
    transform: TransformContextFn,
) -> TransformContextFn {
    Arc::new(move |messages, signal| {
        let wiring = Arc::clone(&wiring);
        let transform = Arc::clone(&transform);
        Box::pin(async move {
            if !wiring.enabled() {
                return transform(messages, signal).await;
            }
            let started_at = Instant::now();
            let result = transform(messages, signal).await?;
            wiring.mark_dispatch(started_at);
            Ok(result)
        })
    })
}

/// TS `instrumentConvertToLlm`: records the prompt-built phase (with the
/// LLM message count) and emits the `prompt-built` phase entry. Without a
/// dispatch mark (the transform seam did not run) the TS fallback
/// timestamps from convert's exit, so the phase measures ~0 rather than
/// the convert duration.
pub fn instrument_convert_to_llm(
    wiring: Arc<RequestTimingWiring>,
    convert: ConvertToLlmFn,
) -> ConvertToLlmFn {
    Arc::new(move |messages| {
        let wiring = Arc::clone(&wiring);
        let convert = Arc::clone(&convert);
        Box::pin(async move {
            if !wiring.enabled() {
                return convert(messages).await;
            }
            let output = convert(messages).await?;
            let started_at = wiring.take_dispatch().unwrap_or_else(Instant::now);
            let built = Instant::now();
            let phase_ms = round_ms(elapsed_ms(started_at, built));
            let timing = PromptBuildTiming {
                messages_ptr: output.as_ptr() as usize,
                dispatched_at: started_at,
                prompt_built_at: built,
                context_entries: output.len(),
                request_seq: wiring.next_request_seq(),
            };
            wiring.set_prompt_build(timing);
            // The prompt-built entry carries no model/session identity:
            // it fires before the request has model or session fields, so
            // later entries correlate by `requestSeq` (TS behavior).
            let mut fields = Map::new();
            fields.insert("phase".to_string(), json!("prompt-built"));
            fields.insert("requestSeq".to_string(), json!(timing.request_seq));
            fields.insert("phaseMs".to_string(), json!(phase_ms));
            fields.insert("totalMs".to_string(), json!(phase_ms));
            fields.insert("contextEntries".to_string(), json!(timing.context_entries));
            wiring.log().info("request timing", fields);
            Ok(output)
        })
    })
}

// ---------------------------------------------------------------------------
// StreamFn seam
// ---------------------------------------------------------------------------

/// The TS wire `stopReason` strings.
fn stop_reason_string(reason: StopReason) -> String {
    match reason {
        StopReason::Stop => "stop",
        StopReason::Length => "length",
        StopReason::ToolUse => "toolUse",
        StopReason::Error => "error",
        StopReason::Aborted => "aborted",
    }
    .to_string()
}

/// First streamed content events (TS `FIRST_TOKEN_EVENT_TYPES`):
/// thinking/text/toolcall starts and deltas.
fn is_request_timing_first_token_event(event: &AssistantMessageEvent) -> bool {
    matches!(
        event,
        AssistantMessageEvent::TextStart { .. }
            | AssistantMessageEvent::TextDelta { .. }
            | AssistantMessageEvent::ThinkingStart { .. }
            | AssistantMessageEvent::ThinkingDelta { .. }
            | AssistantMessageEvent::ToolCallStart { .. }
            | AssistantMessageEvent::ToolCallDelta { .. }
    )
}

/// Serialized request body size (TS `measureRequestBytes`): UTF-8 bytes of
/// the wire payload, not a code-unit count.
fn measure_request_bytes(payload: &Value) -> Option<u64> {
    serde_json::to_vec(payload)
        .ok()
        .map(|bytes| bytes.len() as u64)
}

/// TS `instrumentStreamFn`: creates the per-request clock, chains the
/// payload/response hooks (request-sent / first-byte), wraps the event
/// stream (first-token, stream-done), and emits a failed summary when the
/// provider rejects the request before it is sent.
pub fn instrument_stream_fn(wiring: Arc<RequestTimingWiring>, stream_fn: StreamFn) -> StreamFn {
    Arc::new(move |model, context, options| {
        let wiring = Arc::clone(&wiring);
        let stream_fn = Arc::clone(&stream_fn);
        Box::pin(async move {
            if !wiring.enabled() {
                // Consume this request's own entry (TS: the array key dies
                // with the request) so a re-enabled later request can never
                // inherit it; a non-matching entry (another loop's pending
                // state) stays put.
                wiring.take_prompt_build(context.messages.as_ptr() as usize);
                return stream_fn(model, context, options).await;
            }
            let prompt_build = wiring.take_prompt_build(context.messages.as_ptr() as usize);
            let request_seq = match prompt_build {
                Some(timing) => timing.request_seq,
                None => wiring.next_request_seq(),
            };
            let timing = Arc::new(RequestTiming::new(
                &model,
                &options,
                request_seq,
                prompt_build,
                wiring.log().clone(),
            ));
            let mut options = options;
            // The payload hook chains the inner hook first, then measures
            // the final bytes and marks request-sent: the provider invokes
            // the hook before it opens the HTTP request, so the
            // serialization cost belongs to the client-side build delta,
            // not to request-sent -> first-byte.
            let inner_payload: Option<OnPayloadHook> = options.on_payload.take();
            let timing_for_payload = Arc::clone(&timing);
            let capture_for_payload = wiring.payload_capture.clone();
            let session_id = options.session_id.clone();
            options.on_payload = Some(Arc::new(move |payload, model| {
                let next = inner_payload
                    .as_ref()
                    .and_then(|hook| hook(payload.clone(), model))
                    .unwrap_or(payload);
                timing_for_payload.record_request_bytes(measure_request_bytes(&next));
                timing_for_payload.mark_request_sent();
                if let Some(capture) = capture_for_payload.as_ref() {
                    capture.record(&next, model, session_id.as_deref(), request_seq);
                }
                Some(next)
            }));
            // The response hook marks first-byte before delegating.
            let inner_response: Option<OnResponseHook> = options.on_response.take();
            let timing_for_response = Arc::clone(&timing);
            options.on_response = Some(Arc::new(move |response, model| {
                timing_for_response.mark_first_byte();
                if let Some(hook) = inner_response.as_ref() {
                    hook(response, model);
                }
            }));
            match stream_fn(model, context, options).await {
                Err(error) => {
                    timing.emit_summary(Outcome::Failed);
                    Err(error)
                }
                Ok(stream) => Ok(Box::new(TimingStream {
                    inner: stream,
                    timing,
                }) as Box<dyn ModelStream>),
            }
        })
    })
}

/// Wrap a provider stream so first-byte (fallback via the start event),
/// first-content-token, and the terminal event are timed (TS
/// `wrapRequestTimingEventStream`). Delegates every call to the provider
/// stream so `result`/`close` keep working; only iteration is overridden
/// to observe phases. The summary is emitted on the terminal event, and as
/// aborted when the stream ends or closes early — a hung or aborted request
/// still reports what was measured (the TS iterator `finally`).
struct TimingStream {
    inner: Box<dyn ModelStream>,
    timing: Arc<RequestTiming>,
}

impl ModelStream for TimingStream {
    fn next_event(&mut self) -> pa_agent::BoxFut<'_, Option<AssistantMessageEvent>> {
        let timing = Arc::clone(&self.timing);
        Box::pin(async move {
            let Some(event) = self.inner.next_event().await else {
                timing.emit_summary(Outcome::Aborted);
                return None;
            };
            // TS `default` arm: the first streamed content block clears the
            // Waiting state (start/done/error are never first-token events).
            if is_request_timing_first_token_event(&event) {
                timing.mark_first_token();
            }
            match &event {
                // Providers push start after response headers; used only
                // when the response hook did not fire.
                AssistantMessageEvent::Start { .. } => {
                    timing.mark_first_byte();
                }
                AssistantMessageEvent::Done { reason, message } => {
                    timing.mark_stream_done(
                        stop_reason_string(*reason),
                        message.error_message.clone(),
                    );
                    timing.mark_usage(&message.usage);
                    timing.emit_summary(Outcome::Done);
                }
                AssistantMessageEvent::Error { reason, error } => {
                    timing
                        .mark_stream_done(stop_reason_string(*reason), error.error_message.clone());
                    timing.mark_usage(&error.usage);
                    // A terminal provider error is a failed (or aborted)
                    // request, not a completed one.
                    timing.emit_summary(if *reason == StopReason::Aborted {
                        Outcome::Aborted
                    } else {
                        Outcome::Failed
                    });
                }
                // The remaining content events carry no phase of their own:
                // the first-token check above covers the starts and deltas.
                AssistantMessageEvent::TextStart { .. }
                | AssistantMessageEvent::TextDelta { .. }
                | AssistantMessageEvent::TextEnd { .. }
                | AssistantMessageEvent::ThinkingStart { .. }
                | AssistantMessageEvent::ThinkingDelta { .. }
                | AssistantMessageEvent::ThinkingEnd { .. }
                | AssistantMessageEvent::ToolCallStart { .. }
                | AssistantMessageEvent::ToolCallDelta { .. }
                | AssistantMessageEvent::ToolCallEnd { .. } => {}
            }
            Some(event)
        })
    }

    fn result(
        &mut self,
    ) -> pa_agent::BoxFut<'_, anyhow::Result<pa_agent::types::AssistantMessage>> {
        self.inner.result()
    }

    /// Close/cancel (the loop's abort path): the summary still reports what
    /// was measured.
    fn close(&mut self) {
        self.timing.emit_summary(Outcome::Aborted);
        self.inner.close();
    }
}

impl Drop for TimingStream {
    fn drop(&mut self) {
        // Early termination (abort, hung stream) still reports what was
        // measured; a summary that already fired is a no-op.
        self.timing.emit_summary(Outcome::Aborted);
    }
}

/// `performance.now()` delta in milliseconds.
fn elapsed_ms(from: Instant, to: Instant) -> f64 {
    (to - from).as_secs_f64() * 1000.0
}

/// TS `roundMs`: one decimal of precision.
fn round_ms(delta_ms: f64) -> f64 {
    (delta_ms * 10.0).round() / 10.0
}
