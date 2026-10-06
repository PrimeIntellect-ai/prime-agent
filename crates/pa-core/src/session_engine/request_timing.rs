//! Per-request phase timing for provider requests: splits the pre-first-token
//! wait into client-side phases (dispatch -> prompt-built -> request-sent) and
//! wire/server phases (request-sent -> first-byte); zero overhead when
//! disabled, and one-shot calls outside the agent loop are not instrumented.

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

#[cfg(test)]
mod tests;

mod clock;
mod payload;
use clock::{Outcome, RequestTiming};
pub(crate) use payload::RequestPayloadCapture;

/// The env override (inherited by daemon workers).
const REQUEST_TIMING_ENV: &str = "PI_REQUEST_TIMING";

const LOG_COMPONENT: &str = "coding-agent.request-timing";

const AGENT_LOG_MAX_BYTES: u64 = 20 * 1024 * 1024;

// Flag

/// Evaluated per request so the flag can change without a restart; the
/// env half stays live.
pub type RequestTimingEnabled = Arc<dyn Fn() -> bool + Send + Sync>;

/// 1/true/yes, case-insensitive (the `PI_OFFLINE`/`PI_TIMING` convention).
fn truthy_env_flag(value: Option<&str>) -> bool {
    let Some(value) = value else {
        return false;
    };
    let normalized = value.to_ascii_lowercase();
    normalized == "1" || normalized == "true" || normalized == "yes"
}

/// On when either the settings flag or the env override is set.
#[must_use]
pub fn is_request_timing_enabled(settings_flag: bool) -> bool {
    settings_flag || truthy_env_flag(std::env::var(REQUEST_TIMING_ENV).ok().as_deref())
}

// Log

/// The shared JSONL diagnostic log entries go to: one JSON object per line; writes are best-effort,
/// size-bounded, and never throw into the caller.
#[derive(Debug, Clone)]
pub struct RequestTimingLog {
    path: PathBuf,
    max_bytes: u64,
}

impl RequestTimingLog {
    #[must_use]
    pub fn new(agent_dir: &Path) -> Self {
        Self {
            path: agent_dir.join("logs").join("agent.jsonl"),
            max_bytes: AGENT_LOG_MAX_BYTES,
        }
    }

    #[cfg(test)]
    fn at(path: impl Into<PathBuf>) -> Self {
        Self {
            path: path.into(),
            max_bytes: AGENT_LOG_MAX_BYTES,
        }
    }

    /// The reserved keys (`ts`/`level`/`component`/`msg`/`pid`) win over caller fields so an entry
    /// can never be misclassified; `ts` is ISO-8601 UTC.
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

    /// Every failure is swallowed — a read-only or missing log dir must
    /// never break the operation being logged.
    fn append_rotating_log(&self, line: &str) {
        use std::io::Write;
        let append = || -> std::io::Result<()> {
            std::fs::create_dir_all(self.path.parent().unwrap_or_else(|| Path::new(".")))?;
            // Best-effort rotation: keep appending when the rotate fails.
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
        // destination exists.
        let rotated = self.path.with_extension("jsonl.old");
        let _ = std::fs::remove_file(&rotated);
        std::fs::rename(&self.path, &rotated)
    }
}

// Per-session correlation state

/// `messages_ptr` is the built LLM message array's identity — the loop moves the array by value
/// into the stream call, so its buffer address is what the stream seam matches on.
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

/// Per-session timing state (the Rust seams share one wiring).
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

    /// Arms the payload hook to hand each request's final body to the
    /// capture's bounded writer.
    #[must_use]
    pub(crate) fn with_payload_capture(mut self, capture: RequestPayloadCapture) -> Self {
        self.payload_capture = Some(capture);
        self
    }

    fn log(&self) -> &RequestTimingLog {
        &self.log
    }

    fn enabled(&self) -> bool {
        (self.enabled)()
    }

    /// The latest turn overwrites the previous mark (the loop reuses its
    /// context snapshot per run).
    fn mark_dispatch(&self, at: Instant) {
        *self
            .dispatch
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(at);
    }

    /// The mark is consumed by the first convert that reads it, so a
    /// flag toggle never reuses a dead request's timestamp.
    fn take_dispatch(&self) -> Option<Instant> {
        self.dispatch
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take()
    }

    /// Consumed only on the identity match (see [`PromptBuildTiming`]); a cloned seam without the
    /// paired convert leaves the parent's entry in place.
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

    /// 1-based, one number per request.
    fn next_request_seq(&self) -> u64 {
        self.request_seq.fetch_add(1, Ordering::Relaxed) + 1
    }
}

// Seam wrappers

/// Exists to mark the turn's dispatch moment.
#[must_use]
pub fn pass_through_transform() -> TransformContextFn {
    Arc::new(|messages, _signal| Box::pin(async move { Ok(messages) }))
}

/// Instruments the transform seam — the entry timestamp is the turn's
/// dispatch moment.
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

/// Records the prompt-built phase and emits its entry. Without a
/// dispatch mark the phase measures ~0.
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
            // Fires before the request has model or session fields;
            // later entries correlate by `requestSeq`.
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

// StreamFn seam

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

/// First streamed content events (TS `FIRST_TOKEN_EVENT_TYPES`).
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

/// UTF-8 bytes of the wire payload, not a code-unit count.
fn measure_request_bytes(payload: &Value) -> Option<u64> {
    serde_json::to_vec(payload)
        .ok()
        .map(|bytes| bytes.len() as u64)
}

/// Chains the payload/response hooks, wraps the event stream, and
/// emits a failed summary on a pre-send rejection.
pub fn instrument_stream_fn(wiring: Arc<RequestTimingWiring>, stream_fn: StreamFn) -> StreamFn {
    Arc::new(move |model, context, options| {
        let wiring = Arc::clone(&wiring);
        let stream_fn = Arc::clone(&stream_fn);
        Box::pin(async move {
            if !wiring.enabled() {
                // Consume this request's own entry so a re-enabled later request can never inherit
                // it; a non-matching entry stays put.
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
            // The provider invokes the payload hook before it opens the
            // HTTP request, so the serialization cost belongs to the
            // client-side build delta, not to request-sent -> first-byte.
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

/// Wraps the provider stream to time first-byte (fallback via the start event),
/// first-content-token, and the terminal event; the summary fires as aborted
/// when the stream ends or closes early.
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
            // The first streamed content block clears the Waiting state
            // (start/done/error never count).
            if is_request_timing_first_token_event(&event) {
                timing.mark_first_token();
            }
            match &event {
                // Providers push start after response headers; fallback
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
                    // A terminal provider error is not a completed
                    // request.
                    timing.emit_summary(if *reason == StopReason::Aborted {
                        Outcome::Aborted
                    } else {
                        Outcome::Failed
                    });
                }
                // The first-token check above covers the content starts
                // and deltas.
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

    /// The summary still reports what was measured.
    fn close(&mut self) {
        self.timing.emit_summary(Outcome::Aborted);
        self.inner.close();
    }
}

impl Drop for TimingStream {
    fn drop(&mut self) {
        // Early termination still reports; a fired summary is a no-op.
        self.timing.emit_summary(Outcome::Aborted);
    }
}

/// Milliseconds between two instants.
fn elapsed_ms(from: Instant, to: Instant) -> f64 {
    (to - from).as_secs_f64() * 1000.0
}

/// One decimal of precision.
fn round_ms(delta_ms: f64) -> f64 {
    (delta_ms * 10.0).round() / 10.0
}
