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
use pa_agent::types::{StopReason, Usage};
use serde_json::{json, Map, Value};

use crate::session::manager::format_iso;

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
/// the WeakMap's key semantics: the built LLM message array's identity.
/// The loop moves that array by value into the stream call, so its buffer
/// address is the identity the stream seam matches on — a cloned stream
/// seam without the paired convert (the side-question runs) sees no match
/// and correlates nothing, exactly like the TS WeakMap lookup on a
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
            dispatch: Mutex::new(None),
            prompt_build: Mutex::new(None),
            request_seq: AtomicU64::new(0),
        }
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

    /// TS `takeRequestTimingDispatch`, with the WeakMap's per-key lifetime:
    /// the mark is consumed by the first convert that reads it, so a later
    /// prompt build after a flag toggle never reuses a dead request's
    /// timestamp (a fresh array in TS holds no mark).
    fn take_dispatch(&self) -> Option<Instant> {
        self.dispatch
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take()
    }

    /// TS `takePromptBuild` with the WeakMap's key identity: the entry is
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

/// The pass-through context transform (the stand-in for TS's extension
/// `emitContext` transform, which the Rust engine has not ported yet): it
/// exists so the instrumented seam can mark the turn's dispatch moment.
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
// Per-request clock
// ---------------------------------------------------------------------------

/// Provider request identity fields shared by every phase entry (TS
/// `RequestTimingRequestInfo`).
#[derive(Debug, Clone)]
struct RequestInfo {
    model: String,
    provider: String,
    api: String,
    session_id: Option<String>,
}

impl RequestInfo {
    /// TS `identity()`: empty/absent fields are omitted.
    fn fields(&self) -> Map<String, Value> {
        let mut fields = Map::new();
        fields.insert("model".to_string(), json!(self.model));
        if !self.provider.is_empty() {
            fields.insert("provider".to_string(), json!(self.provider));
        }
        if !self.api.is_empty() {
            fields.insert("api".to_string(), json!(self.api));
        }
        if let Some(session_id) = &self.session_id {
            fields.insert("sessionId".to_string(), json!(session_id));
        }
        fields
    }
}

/// Final usage carried by the summary (TS `{input, output, cacheRead,
/// cacheWrite}`).
#[derive(Debug, Clone, Copy)]
struct TimingUsage {
    input: u64,
    output: u64,
    cache_read: u64,
    cache_write: u64,
}

impl From<&Usage> for TimingUsage {
    fn from(usage: &Usage) -> Self {
        TimingUsage {
            input: usage.input,
            output: usage.output,
            cache_read: usage.cache_read,
            cache_write: usage.cache_write,
        }
    }
}

impl TimingUsage {
    fn fields(&self) -> Value {
        json!({
            "input": self.input,
            "output": self.output,
            "cacheRead": self.cache_read,
            "cacheWrite": self.cache_write,
        })
    }
}

/// The summary outcome (TS `emitSummary(outcome: "done" | "aborted" |
/// "failed")`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Outcome {
    Done,
    Aborted,
    Failed,
}

impl Outcome {
    fn as_str(self) -> &'static str {
        match self {
            Outcome::Done => "done",
            Outcome::Aborted => "aborted",
            Outcome::Failed => "failed",
        }
    }
}

/// Mutable phase clock for one provider request (TS `RequestTiming`).
/// Created at the streamFn seam; phase transitions are logged as they
/// happen so a hung request shows the last completed phase in the live log.
#[derive(Debug)]
struct RequestTiming {
    request_seq: u64,
    info: RequestInfo,
    log: RequestTimingLog,
    dispatched_at: Option<Instant>,
    prompt_built_at: Option<Instant>,
    context_entries: Option<usize>,
    stream_fn_entered_at: Instant,
    inner: Mutex<RequestTimingInner>,
}

#[derive(Debug, Default)]
struct RequestTimingInner {
    request_sent_at: Option<Instant>,
    request_bytes: Option<u64>,
    first_byte_at: Option<Instant>,
    first_token_at: Option<Instant>,
    stream_done_at: Option<Instant>,
    stop_reason: Option<String>,
    error_message: Option<String>,
    usage: Option<TimingUsage>,
    summary_emitted: bool,
}

impl RequestTiming {
    fn new(
        model: &pa_agent::types::Model,
        options: &StreamRequestOptions,
        request_seq: u64,
        prompt_build: Option<PromptBuildTiming>,
        log: RequestTimingLog,
    ) -> Self {
        Self {
            request_seq,
            info: RequestInfo {
                model: model.id.clone(),
                provider: model.provider.clone(),
                api: model.api.clone(),
                session_id: options.session_id.clone(),
            },
            log,
            dispatched_at: prompt_build.map(|timing| timing.dispatched_at),
            prompt_built_at: prompt_build.map(|timing| timing.prompt_built_at),
            context_entries: prompt_build.map(|timing| timing.context_entries),
            stream_fn_entered_at: Instant::now(),
            inner: Mutex::default(),
        }
    }

    /// request-sent: payload handed to the provider client.
    fn mark_request_sent(&self) {
        let (phase_ms, total_ms) = {
            let now = Instant::now();
            let mut inner = self
                .inner
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if inner.request_sent_at.is_some() {
                return;
            }
            inner.request_sent_at = Some(now);
            let from = self.prompt_built_at.unwrap_or(self.stream_fn_entered_at);
            (
                round_ms(elapsed_ms(from, now)),
                self.total_from_dispatch(now),
            )
        };
        let mut fields = Map::new();
        fields.insert("phase".to_string(), json!("request-sent"));
        fields.insert("phaseMs".to_string(), json!(phase_ms));
        if let Some(total_ms) = total_ms {
            fields.insert("totalMs".to_string(), json!(total_ms));
        }
        if let Some(context_entries) = self.context_entries {
            fields.insert("contextEntries".to_string(), json!(context_entries));
        }
        self.emit("request timing", fields);
    }

    /// Serialized request body size, measured before request-sent so its
    /// cost lands in the client-side phase.
    fn record_request_bytes(&self, request_bytes: Option<u64>) {
        self.inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .request_bytes = request_bytes;
    }

    /// first-byte: HTTP response headers received (provider TTFB complete).
    fn mark_first_byte(&self) {
        let (phase_ms, phase_from, total_ms, request_bytes) = {
            let now = Instant::now();
            let mut inner = self
                .inner
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if inner.first_byte_at.is_some() {
                return;
            }
            inner.first_byte_at = Some(now);
            // Without a request-sent timestamp (the provider never invoked
            // the payload hook) the delta spans from prompt-built, not
            // just the wire wait (TS `phaseFrom`).
            let (from, phase_from) = match inner.request_sent_at {
                Some(sent) => (sent, None),
                None => (
                    self.prompt_built_at.unwrap_or(self.stream_fn_entered_at),
                    Some("prompt-built"),
                ),
            };
            (
                round_ms(elapsed_ms(from, now)),
                phase_from,
                self.total_from_dispatch(now),
                inner.request_bytes,
            )
        };
        let mut fields = Map::new();
        fields.insert("phase".to_string(), json!("first-byte"));
        fields.insert("phaseMs".to_string(), json!(phase_ms));
        if let Some(phase_from) = phase_from {
            fields.insert("phaseFrom".to_string(), json!(phase_from));
        }
        if let Some(total_ms) = total_ms {
            fields.insert("totalMs".to_string(), json!(total_ms));
        }
        if let Some(request_bytes) = request_bytes {
            fields.insert("requestBytes".to_string(), json!(request_bytes));
        }
        self.emit("request timing", fields);
    }

    /// first-content-token: first streamed content block (thinking/text/
    /// toolcall), which clears the TUI Waiting state.
    fn mark_first_token(&self) {
        let (phase_ms, total_ms) = {
            let now = Instant::now();
            let mut inner = self
                .inner
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if inner.first_token_at.is_some() {
                return;
            }
            inner.first_token_at = Some(now);
            let from = inner
                .first_byte_at
                .or(inner.request_sent_at)
                .unwrap_or(self.stream_fn_entered_at);
            (
                round_ms(elapsed_ms(from, now)),
                self.total_from_dispatch(now),
            )
        };
        let mut fields = Map::new();
        fields.insert("phase".to_string(), json!("first-token"));
        fields.insert("phaseMs".to_string(), json!(phase_ms));
        if let Some(total_ms) = total_ms {
            fields.insert("totalMs".to_string(), json!(total_ms));
        }
        self.emit("request timing", fields);
    }

    /// stream-done: terminal event observed on the provider stream.
    fn mark_stream_done(&self, stop_reason: String, error_message: Option<String>) {
        let mut inner = self
            .inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        inner.stop_reason = Some(stop_reason);
        inner.error_message = error_message;
        inner.stream_done_at = Some(Instant::now());
    }

    /// Final usage from the completed assistant message; cache read/write
    /// answers prompt-cache misses.
    fn mark_usage(&self, usage: &Usage) {
        self.inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .usage = Some(TimingUsage::from(usage));
    }

    /// Emit the summary with every known phase delta (TS `emitSummary`).
    /// Safe to call once; later calls are ignored.
    fn emit_summary(&self, outcome: Outcome) {
        let fields = {
            let mut inner = self
                .inner
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if inner.summary_emitted {
                return;
            }
            inner.summary_emitted = true;
            let done_at = inner.stream_done_at.unwrap_or_else(Instant::now);
            let mut phases = Map::new();
            if let (Some(dispatched), Some(built)) = (self.dispatched_at, self.prompt_built_at) {
                phases.insert(
                    "dispatchToPromptBuiltMs".to_string(),
                    json!(round_ms(elapsed_ms(dispatched, built))),
                );
            }
            let request_start = self.prompt_built_at.unwrap_or(self.stream_fn_entered_at);
            if let Some(sent) = inner.request_sent_at {
                phases.insert(
                    "promptBuiltToRequestSentMs".to_string(),
                    json!(round_ms(elapsed_ms(request_start, sent))),
                );
            }
            if let (Some(sent), Some(first_byte)) = (inner.request_sent_at, inner.first_byte_at) {
                phases.insert(
                    "requestSentToFirstByteMs".to_string(),
                    json!(round_ms(elapsed_ms(sent, first_byte))),
                );
            }
            let first_token_from = inner.first_byte_at.or(inner.request_sent_at);
            if let (Some(first_token), Some(from)) = (inner.first_token_at, first_token_from) {
                phases.insert(
                    "firstByteToFirstTokenMs".to_string(),
                    json!(round_ms(elapsed_ms(from, first_token))),
                );
            }
            if let Some(first_token) = inner.first_token_at {
                phases.insert(
                    "firstTokenToStreamDoneMs".to_string(),
                    json!(round_ms(elapsed_ms(first_token, done_at))),
                );
            }
            let mut fields = Map::new();
            fields.insert("phase".to_string(), json!("stream-done"));
            fields.insert("requestSeq".to_string(), json!(self.request_seq));
            fields.insert("outcome".to_string(), json!(outcome.as_str()));
            for (key, value) in self.info.fields() {
                fields.insert(key, value);
            }
            if let Some(context_entries) = self.context_entries {
                fields.insert("contextEntries".to_string(), json!(context_entries));
            }
            if let Some(request_bytes) = inner.request_bytes {
                fields.insert("requestBytes".to_string(), json!(request_bytes));
            }
            fields.insert("phases".to_string(), Value::Object(phases));
            let total_ms = self
                .total_from_dispatch(done_at)
                .unwrap_or_else(|| round_ms(elapsed_ms(self.stream_fn_entered_at, done_at)));
            fields.insert("totalMs".to_string(), json!(total_ms));
            if let Some(stop_reason) = &inner.stop_reason {
                fields.insert("stopReason".to_string(), json!(stop_reason));
            }
            if let Some(error_message) = &inner.error_message {
                fields.insert("errorMessage".to_string(), json!(error_message));
            }
            if let Some(usage) = inner.usage {
                fields.insert("usage".to_string(), usage.fields());
            }
            fields
        };
        self.log.info("request timing summary", fields);
    }

    /// TS `emit`: phase entry with the request sequence and identity.
    fn emit(&self, msg: &str, mut fields: Map<String, Value>) {
        fields.insert("requestSeq".to_string(), json!(self.request_seq));
        for (key, value) in self.info.fields() {
            fields.insert(key, value);
        }
        self.log.info(msg, fields);
    }

    /// Elapsed since turn dispatch, when the dispatch seam ran.
    fn total_from_dispatch(&self, at: Instant) -> Option<f64> {
        self.dispatched_at
            .map(|dispatched| round_ms(elapsed_ms(dispatched, at)))
    }
}

// ---------------------------------------------------------------------------
// StreamFn seam
// ---------------------------------------------------------------------------

/// The TS wire `stopReason` strings.
fn stop_reason_string(reason: &StopReason) -> String {
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
            options.on_payload = Some(Arc::new(move |payload, model| {
                let next = inner_payload
                    .as_ref()
                    .and_then(|hook| hook(payload.clone(), model))
                    .unwrap_or(payload);
                timing_for_payload.record_request_bytes(measure_request_bytes(&next));
                timing_for_payload.mark_request_sent();
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
                        stop_reason_string(reason),
                        message.error_message.clone(),
                    );
                    timing.mark_usage(&message.usage);
                    timing.emit_summary(Outcome::Done);
                }
                AssistantMessageEvent::Error { reason, error } => {
                    timing
                        .mark_stream_done(stop_reason_string(reason), error.error_message.clone());
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

// ---------------------------------------------------------------------------
// Tests (port of `packages/coding-agent/test/request-timing.test.ts`)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use pa_agent::stream::{event_stream, LlmContext};
    use pa_agent::types::{
        AgentMessage, AssistantContent, Message, TextContent, UsageCost, UserContent, UserMessage,
    };
    use std::sync::atomic::{AtomicUsize, Ordering as AtomicOrdering};

    /// Tests that touch the `PI_REQUEST_TIMING` env serialize on this lock:
    /// the process env is global across parallel test threads.
    static REQUEST_TIMING_ENV_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    fn test_model() -> pa_agent::types::Model {
        pa_agent::types::Model {
            id: "bench/bench-model".to_string(),
            name: "Bench".to_string(),
            api: "openai-completions".to_string(),
            provider: "bench".to_string(),
            base_url: "https://bench.test/v1".to_string(),
            reasoning: true,
            cost: UsageCost::default(),
            context_window: 1_000_000,
            max_tokens: 128_000,
        }
    }

    /// TS `PAYLOAD` (UTF-8 non-ASCII content included, so a code-unit count
    /// would underreport).
    fn payload() -> Value {
        json!({"messages": [{"role": "user", "content": "hello \u{1F680}"}]})
    }

    /// TS `finalMessage()`: the usage the summary must account.
    fn final_message(model: &pa_agent::types::Model) -> pa_agent::types::AssistantMessage {
        let mut message = empty_partial(model);
        message.content = vec![AssistantContent::Thinking(
            pa_agent::types::ThinkingContent {
                thinking: "hm".to_string(),
                thinking_signature: None,
                redacted: None,
            },
        )];
        message.usage = pa_agent::types::Usage {
            input: 800_000,
            output: 12,
            cache_read: 790_000,
            cache_write: 0,
            total_tokens: 800_012,
            cost: UsageCost::default(),
        };
        message
    }

    fn empty_partial(model: &pa_agent::types::Model) -> pa_agent::types::AssistantMessage {
        pa_agent::types::AssistantMessage {
            content: Vec::new(),
            api: model.api.clone(),
            provider: model.provider.clone(),
            model: model.id.clone(),
            response_model: None,
            response_id: None,
            diagnostics: None,
            usage: pa_agent::types::Usage::zero(),
            stop_reason: StopReason::Stop,
            stop_reason_raw: None,
            error_message: None,
            timestamp: 0,
        }
    }

    /// TS `createGate`.
    fn gate() -> (
        tokio::sync::oneshot::Sender<()>,
        tokio::sync::oneshot::Receiver<()>,
    ) {
        tokio::sync::oneshot::channel()
    }

    /// The timing entries from the JSONL log (TS `timingEntries()` filters
    /// the sink by component).
    fn timing_entries(path: &Path) -> Vec<Value> {
        let content = std::fs::read_to_string(path).unwrap_or_default();
        content
            .lines()
            .filter_map(|line| serde_json::from_str::<Value>(line).ok())
            .filter(|entry| entry.get("component").and_then(Value::as_str) == Some(LOG_COMPONENT))
            .collect()
    }

    fn phases_of(entries: &[Value]) -> Vec<&str> {
        entries
            .iter()
            .map(|entry| {
                entry
                    .get("phase")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
            })
            .collect()
    }

    async fn drain(mut stream: Box<dyn ModelStream>) {
        while stream.next_event().await.is_some() {}
    }

    /// TS `scriptedProvider`: the payload hook fires at request time, the
    /// response hook (when the provider reports one) after the response
    /// gate, then start / first-token / done behind their gates.
    fn scripted_provider(
        model: pa_agent::types::Model,
        response_gate: tokio::sync::oneshot::Receiver<()>,
        first_token_gate: tokio::sync::oneshot::Receiver<()>,
        done_gate: tokio::sync::oneshot::Receiver<()>,
        with_response_hook: bool,
    ) -> StreamFn {
        // An `Fn` stream seam cannot move its captures per call, so the
        // one-shot receivers ride an interior-mutable slot the task takes
        // them from.
        let response_gate = Arc::new(Mutex::new(Some(response_gate)));
        let first_token_gate = Arc::new(Mutex::new(Some(first_token_gate)));
        let done_gate = Arc::new(Mutex::new(Some(done_gate)));
        Arc::new(move |_model, _context, options| {
            let model = model.clone();
            let response_gate = Arc::clone(&response_gate);
            let first_token_gate = Arc::clone(&first_token_gate);
            let done_gate = Arc::clone(&done_gate);
            Box::pin(async move {
                let response_gate = response_gate
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .take()
                    .expect("one scripted request per provider");
                let first_token_gate = first_token_gate
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .take()
                    .expect("one scripted request per provider");
                let done_gate = done_gate
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .take()
                    .expect("one scripted request per provider");
                let (handle, consumer) = event_stream();
                let hook_model = model.clone();
                let final_msg = final_message(&model);
                let task = async move {
                    if let Some(on_payload) = options.on_payload.as_ref() {
                        let _ = on_payload(payload(), &hook_model);
                    }
                    let _ = response_gate.await;
                    if with_response_hook {
                        if let Some(on_response) = options.on_response.as_ref() {
                            on_response(
                                pa_agent::stream::ProviderResponse {
                                    status: 200,
                                    headers: std::collections::BTreeMap::default(),
                                },
                                &hook_model,
                            );
                        }
                    }
                    handle.push(AssistantMessageEvent::Start {
                        partial: final_msg.clone(),
                    });
                    let _ = first_token_gate.await;
                    handle.push(AssistantMessageEvent::ThinkingStart {
                        content_index: 0,
                        partial: final_msg.clone(),
                    });
                    let _ = done_gate.await;
                    handle.push(AssistantMessageEvent::Done {
                        reason: StopReason::Stop,
                        message: final_msg,
                    });
                };
                tokio::spawn(task);
                Ok(Box::new(consumer) as Box<dyn ModelStream>)
            })
        })
    }

    /// TS `runTimedRequest`: transform -> convert (prompt-built entry) ->
    /// the instrumented stream seam, with timing always on.
    async fn run_timed_request(
        wiring: Arc<RequestTimingWiring>,
        stream_fn: StreamFn,
    ) -> anyhow::Result<Box<dyn ModelStream>> {
        let transform = instrument_transform_context(Arc::clone(&wiring), pass_through_transform());
        // TS converts identity; the loop's two message types differ, so the
        // fixture emits the single user message the context carries.
        let convert = instrument_convert_to_llm(
            Arc::clone(&wiring),
            Arc::new(|_messages: Vec<AgentMessage>| {
                Box::pin(async move {
                    Ok(vec![Message::User(UserMessage {
                        content: UserContent::Text("hello".to_string()),
                        timestamp: 0,
                    })])
                })
            }),
        );
        let input = vec![AgentMessage::user("hello")];
        let llm_messages =
            convert(transform(input, pa_agent::abort::AbortSignal::default()).await?).await?;
        let options = StreamRequestOptions {
            session_id: Some("sess-timing".to_string()),
            ..Default::default()
        };
        let context = LlmContext {
            system_prompt: None,
            messages: llm_messages,
            tools: Vec::new(),
        };
        instrument_stream_fn(wiring, stream_fn)(test_model(), context, options).await
    }

    fn timing_on(log_path: &Path) -> Arc<RequestTimingWiring> {
        Arc::new(RequestTimingWiring::new(
            Arc::new(|| true),
            RequestTimingLog::at(log_path),
        ))
    }

    #[tokio::test]
    async fn emits_the_full_timeline_first_byte_from_the_response_hook() {
        emits_the_full_timeline(true).await;
    }

    #[tokio::test]
    async fn emits_the_full_timeline_first_byte_from_the_start_event() {
        emits_the_full_timeline(false).await;
    }

    /// TS `it.each(["first-byte from onResponse", "first-byte from the
    /// start event when onResponse is omitted"])`: the five phases in order,
    /// one request sequence, and the summary's accounting. The TS fake
    /// timers pin exact deltas; the Rust port pins the timeline shape (the
    /// entries, their order, and their fields — every measured delta is
    /// present and non-negative).
    async fn emits_the_full_timeline(with_response_hook: bool) {
        let dir = tempfile::tempdir().unwrap();
        let log_path = dir.path().join("agent.jsonl");
        let wiring = timing_on(&log_path);
        let (response_tx, response_rx) = gate();
        let (first_token_tx, first_token_rx) = gate();
        let (done_tx, done_rx) = gate();
        let stream = run_timed_request(
            Arc::clone(&wiring),
            scripted_provider(
                test_model(),
                response_rx,
                first_token_rx,
                done_rx,
                with_response_hook,
            ),
        )
        .await
        .unwrap();
        response_tx.send(()).unwrap();
        first_token_tx.send(()).unwrap();
        done_tx.send(()).unwrap();
        drain(stream).await;

        let entries = timing_entries(&log_path);
        assert_eq!(
            phases_of(&entries).join(","),
            "prompt-built,request-sent,first-byte,first-token,stream-done",
            "entries: {entries:?}"
        );
        let seqs: Vec<&Value> = entries
            .iter()
            .filter_map(|entry| entry.get("requestSeq"))
            .collect();
        assert!(!seqs.is_empty(), "every entry carries requestSeq");
        assert!(
            seqs.iter().all(|seq| *seq == seqs[0]),
            "one request sequence: {seqs:?}"
        );
        let summary = entries.last().unwrap();
        let get = |key: &str| summary.get(key).cloned().unwrap_or(Value::Null);
        assert_eq!(get("outcome"), json!("done"));
        assert_eq!(get("contextEntries"), json!(1));
        assert_eq!(
            get("requestBytes"),
            json!(serde_json::to_vec(&payload()).unwrap().len() as u64)
        );
        assert_eq!(
            get("usage"),
            json!({"input": 800_000, "output": 12, "cacheRead": 790_000, "cacheWrite": 0}),
        );
        assert_eq!(get("stopReason"), json!("stop"));
        assert_eq!(get("model"), json!("bench/bench-model"));
        assert_eq!(get("provider"), json!("bench"));
        assert_eq!(get("api"), json!("openai-completions"));
        assert_eq!(get("sessionId"), json!("sess-timing"));
        let phases = get("phases");
        for key in [
            "dispatchToPromptBuiltMs",
            "promptBuiltToRequestSentMs",
            "requestSentToFirstByteMs",
            "firstByteToFirstTokenMs",
            "firstTokenToStreamDoneMs",
        ] {
            let phase_ms = phases
                .get(key)
                .and_then(Value::as_f64)
                .unwrap_or_else(|| panic!("phase {key} present: {phases}"));
            assert!(phase_ms >= 0.0, "phase {key} = {phase_ms}");
        }
        assert!(get("totalMs").as_f64().unwrap() >= 0.0);
    }

    #[tokio::test]
    async fn measures_the_payload_once_and_never_when_disabled() {
        let dir = tempfile::tempdir().unwrap();
        let log_path = dir.path().join("agent.jsonl");

        // The inner (loop-config stand-in) hook: counts its calls and hands
        // the provider the probe payload (TS `probe.toJSON`).
        let inner_calls = Arc::new(AtomicUsize::new(0));
        let inner_calls_for_hook = Arc::clone(&inner_calls);
        let marked_hook: OnPayloadHook = Arc::new(move |_payload, _model| {
            inner_calls_for_hook.fetch_add(1, AtomicOrdering::SeqCst);
            Some(payload())
        });
        let seen_hooks: Arc<Mutex<Vec<Option<OnPayloadHook>>>> = Arc::new(Mutex::new(Vec::new()));
        let base_stream_fn: StreamFn = {
            let seen_hooks = Arc::clone(&seen_hooks);
            Arc::new(move |_model, _context, options| {
                let seen_hooks = Arc::clone(&seen_hooks);
                let on_payload = options.on_payload.clone();
                let model = test_model();
                Box::pin(async move {
                    seen_hooks
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner)
                        .push(on_payload);
                    let (handle, consumer) = event_stream();
                    let message = empty_partial(&model);
                    handle.push(AssistantMessageEvent::Done {
                        reason: StopReason::Stop,
                        message,
                    });
                    if let Some(on_payload) = &options.on_payload {
                        let _ = on_payload(json!({"sentinel": "input-payload"}), &model);
                    }
                    Ok(Box::new(consumer) as Box<dyn ModelStream>)
                })
            })
        };

        // Disabled: the options pass through untouched (the hook the inner
        // stream sees is the same `Arc`), and no entry is written.
        let wiring_off = Arc::new(RequestTimingWiring::new(
            Arc::new(|| false),
            RequestTimingLog::at(&log_path),
        ));
        let options = StreamRequestOptions {
            session_id: Some("sess-off".to_string()),
            on_payload: Some(Arc::clone(&marked_hook)),
            ..Default::default()
        };
        let stream = (instrument_stream_fn(wiring_off, Arc::clone(&base_stream_fn)))(
            test_model(),
            LlmContext::default(),
            options,
        )
        .await
        .unwrap();
        drain(stream).await;
        assert!(timing_entries(&log_path).is_empty(), "flag-off silence");
        {
            let seen = seen_hooks
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            assert_eq!(seen.len(), 1, "only the disabled run so far");
            let seen_hook = seen[0].as_ref().expect("hook reaches the provider");
            assert!(
                Arc::ptr_eq(seen_hook, &marked_hook),
                "disabled passes the hook through unchanged"
            );
        }

        // Enabled: the composed hook measures the payload the inner hook
        // returned exactly once (one request-sent entry), the size lands on
        // the later entries, not request-sent.
        let wiring = timing_on(&log_path);
        let on_options = StreamRequestOptions {
            on_payload: Some(Arc::clone(&marked_hook)),
            ..Default::default()
        };
        let stream = (instrument_stream_fn(wiring, Arc::clone(&base_stream_fn)))(
            test_model(),
            LlmContext::default(),
            on_options,
        )
        .await
        .unwrap();
        drain(stream).await;
        let enabled = timing_entries(&log_path);
        let request_sent: Vec<&Value> = enabled
            .iter()
            .filter(|entry| entry.get("phase") == Some(&json!("request-sent")))
            .collect();
        assert_eq!(request_sent.len(), 1, "one measurement per request");
        assert!(
            request_sent[0].get("requestBytes").is_none(),
            "request-sent carries no bytes yet: {request_sent:?}"
        );
        assert_eq!(
            inner_calls.load(AtomicOrdering::SeqCst),
            2,
            "the inner hook ran once per request (disabled + enabled runs)"
        );
        {
            let seen = seen_hooks
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let seen_hook = seen[1]
                .as_ref()
                .expect("the composed hook reaches the provider");
            assert!(
                !Arc::ptr_eq(seen_hook, &marked_hook),
                "enabled composes the timing hook around the inner hook"
            );
        }
        let summary = enabled.last().expect("summary entry");
        assert_eq!(
            summary.get("requestBytes"),
            Some(&json!(serde_json::to_vec(&payload()).unwrap().len() as u64)),
            "the inner hook's returned payload is what gets measured: {summary}"
        );
    }

    /// A cloned stream seam without the paired convert (the side-question
    /// runs) must not consume the parent request's correlation: the TS
    /// WeakMap lookup on its never-marked array returns nothing, so the
    /// port's identity-matched slot leaves the parent's entry in place and
    /// the side question correlates on a fresh sequence.
    #[tokio::test]
    async fn a_cloned_stream_seam_never_steals_the_parent_correlation() {
        let dir = tempfile::tempdir().unwrap();
        let log_path = dir.path().join("agent.jsonl");
        let wiring = timing_on(&log_path);
        let provider: StreamFn = Arc::new(|_model, _context, _options| {
            Box::pin(async move {
                let (handle, consumer) = event_stream();
                handle.end(None);
                Ok(Box::new(consumer) as Box<dyn ModelStream>)
            })
        });

        // The parent turn: convert stores the prompt-build entry keyed by
        // the identity of the messages it built.
        let convert = instrument_convert_to_llm(
            Arc::clone(&wiring),
            Arc::new(|_messages: Vec<AgentMessage>| {
                Box::pin(async move {
                    Ok(vec![Message::User(UserMessage {
                        content: UserContent::Text("hello".to_string()),
                        timestamp: 0,
                    })])
                })
            }),
        );
        let parent_messages = convert(vec![AgentMessage::user("hello")]).await.unwrap();

        // The side question: its own (never-marked) context through the
        // same wrapped stream seam.
        let side_context = LlmContext {
            system_prompt: None,
            messages: vec![Message::User(UserMessage {
                content: UserContent::Text("meanwhile".to_string()),
                timestamp: 0,
            })],
            tools: Vec::new(),
        };
        drain(
            instrument_stream_fn(Arc::clone(&wiring), Arc::clone(&provider))(
                test_model(),
                side_context,
                StreamRequestOptions::default(),
            )
            .await
            .unwrap(),
        )
        .await;

        let entries = timing_entries(&log_path);
        let summary = entries.last().expect("the side question's summary");
        assert_eq!(summary.get("outcome"), Some(&json!("aborted")));
        assert_ne!(
            summary.get("requestSeq"),
            Some(&json!(1)),
            "the side question gets a fresh sequence, not the parent's"
        );
        assert!(
            summary.get("contextEntries").is_none(),
            "nothing correlates to the side question's context: {summary}"
        );

        // The parent's own stream call still finds its entry (the same
        // array, moved by value into the request).
        drain(
            instrument_stream_fn(Arc::clone(&wiring), Arc::clone(&provider))(
                test_model(),
                LlmContext {
                    system_prompt: None,
                    messages: parent_messages,
                    tools: Vec::new(),
                },
                StreamRequestOptions::default(),
            )
            .await
            .unwrap(),
        )
        .await;
        let entries = timing_entries(&log_path);
        let summary = entries.last().expect("the parent's summary");
        assert_eq!(
            summary.get("requestSeq"),
            Some(&json!(1)),
            "the parent's correlation survived the side question: {summary}"
        );
        assert_eq!(summary.get("contextEntries"), Some(&json!(1)));
        assert!(
            summary
                .get("phases")
                .and_then(|phases| phases.get("dispatchToPromptBuiltMs"))
                .is_some(),
            "the parent's prompt-build phases ride along: {summary}"
        );
    }

    /// TS "reports provider failures as failed instead of losing the
    /// timeline": the fn-level failure (auth rejects before the request is
    /// sent) maps to the Rust `StreamFn` error — the closest seam, since
    /// the Rust stream protocol encodes failures as terminal events and
    /// cannot throw mid-iteration.
    #[tokio::test]
    async fn reports_stream_fn_failures_as_failed() {
        let dir = tempfile::tempdir().unwrap();
        let log_path = dir.path().join("agent.jsonl");
        let wiring = timing_on(&log_path);
        let failing: StreamFn = Arc::new(|_model, _context, _options| {
            Box::pin(async move { Err(anyhow::anyhow!("socket hang up")) })
        });
        // `Box<dyn ModelStream>` is not `Debug`, so the error side is
        // let-else'd out instead of `unwrap_err`.
        let Err(error) = instrument_stream_fn(wiring, failing)(
            test_model(),
            LlmContext::default(),
            StreamRequestOptions::default(),
        )
        .await
        else {
            panic!("the failing stream fn must propagate its error");
        };
        assert_eq!(error.to_string(), "socket hang up", "the error propagates");
        let entries = timing_entries(&log_path);
        let summary = entries.last().expect("failed summary");
        assert_eq!(summary.get("phase"), Some(&json!("stream-done")));
        assert_eq!(summary.get("outcome"), Some(&json!("failed")));
        assert!(
            summary.get("stopReason").is_none() && summary.get("errorMessage").is_none(),
            "the fn-level failure carries no stream outcome fields: {summary}"
        );
    }

    /// Terminal provider error events report as failed (or aborted), with
    /// the stop reason, error message, and usage from the error message.
    #[tokio::test]
    async fn reports_terminal_error_events() {
        for (stop_reason, outcome, reason_text) in [
            (StopReason::Error, "failed", "error"),
            (StopReason::Aborted, "aborted", "aborted"),
        ] {
            let dir = tempfile::tempdir().unwrap();
            let log_path = dir.path().join("agent.jsonl");
            let wiring = timing_on(&log_path);
            let model = test_model();
            let error_stream: StreamFn = Arc::new(move |_model, _context, _options| {
                let model = model.clone();
                Box::pin(async move {
                    let (handle, consumer) = event_stream();
                    let mut error = empty_partial(&model);
                    error.content = vec![AssistantContent::Text(TextContent {
                        text: String::new(),
                        text_signature: None,
                    })];
                    error.stop_reason = stop_reason;
                    error.error_message = Some("provider exploded".to_string());
                    error.usage = final_message(&model).usage;
                    handle.push(AssistantMessageEvent::Start {
                        partial: empty_partial(&model),
                    });
                    handle.push(AssistantMessageEvent::Error {
                        reason: stop_reason,
                        error,
                    });
                    Ok(Box::new(consumer) as Box<dyn ModelStream>)
                })
            });
            let stream = instrument_stream_fn(wiring, error_stream)(
                test_model(),
                LlmContext::default(),
                StreamRequestOptions::default(),
            )
            .await
            .unwrap();
            drain(stream).await;
            let entries = timing_entries(&log_path);
            let summary = entries.last().expect("summary entry");
            assert_eq!(
                phases_of(&entries).join(","),
                "first-byte,stream-done",
                "the start event still marks first-byte: {entries:?}"
            );
            assert_eq!(summary.get("outcome"), Some(&json!(outcome)));
            assert_eq!(summary.get("stopReason"), Some(&json!(reason_text)));
            assert_eq!(
                summary.get("errorMessage"),
                Some(&json!("provider exploded"))
            );
            assert_eq!(
                summary.get("usage"),
                Some(
                    &json!({"input": 800_000, "output": 12, "cacheRead": 790_000, "cacheWrite": 0})
                ),
            );
        }
    }

    /// A stream that ends without a terminal event (abort, hung stream)
    /// still reports what was measured — outcome aborted (the TS iterator
    /// `finally`).
    #[tokio::test]
    async fn reports_early_termination_as_aborted() {
        let dir = tempfile::tempdir().unwrap();
        let log_path = dir.path().join("agent.jsonl");
        let wiring = timing_on(&log_path);
        let ending: StreamFn = Arc::new(|_model, _context, _options| {
            Box::pin(async move {
                let (handle, consumer) = event_stream();
                handle.end(None);
                Ok(Box::new(consumer) as Box<dyn ModelStream>)
            })
        });
        let stream = instrument_stream_fn(wiring, ending)(
            test_model(),
            LlmContext::default(),
            StreamRequestOptions::default(),
        )
        .await
        .unwrap();
        drain(stream).await;
        let entries = timing_entries(&log_path);
        let summary = entries.last().expect("summary entry");
        assert_eq!(summary.get("outcome"), Some(&json!("aborted")));
    }

    /// TS `truthyEnvFlag` parsing (the env values that count as on).
    #[test]
    fn truthy_env_flag_follows_the_offline_convention() {
        for on in ["1", "true", "yes", "TRUE", "Yes"] {
            assert!(truthy_env_flag(Some(on)), "{on} is on");
        }
        for off in [
            None,
            Some(""),
            Some("0"),
            Some("false"),
            Some("no"),
            Some("off"),
        ] {
            assert!(!truthy_env_flag(off), "{off:?} is off");
        }
    }

    /// The env half of `is_request_timing_enabled` (serialized on the env
    /// lock: the process env is global).
    #[tokio::test]
    async fn the_env_override_enables_request_timing() {
        let _guard = REQUEST_TIMING_ENV_LOCK.lock().await;
        let previous = std::env::var(REQUEST_TIMING_ENV).ok();
        std::env::remove_var(REQUEST_TIMING_ENV);
        assert!(!is_request_timing_enabled(false), "off without the flag");
        std::env::set_var(REQUEST_TIMING_ENV, "1");
        assert!(is_request_timing_enabled(false), "the env alone is on");
        assert!(is_request_timing_enabled(true), "either half is on");
        match previous {
            Some(value) => std::env::set_var(REQUEST_TIMING_ENV, value),
            None => std::env::remove_var(REQUEST_TIMING_ENV),
        }
    }

    /// The settings half: the `requestTiming` key (camelCase on the wire)
    /// round-trips and the getter defaults to off.
    #[test]
    fn the_settings_flag_round_trips_and_defaults_off() {
        let settings: crate::settings::Settings =
            serde_json::from_str(r#"{"requestTiming": true}"#).unwrap();
        assert_eq!(settings.request_timing, Some(true));
        assert!(
            crate::settings::SettingsManager::in_memory(settings).get_request_timing(),
            "the getter reads the merged flag"
        );
        assert!(
            !crate::settings::SettingsManager::in_memory(crate::settings::Settings::default())
                .get_request_timing(),
            "unset means off"
        );
    }

    /// TS "pins the sdk wiring: faux sessions emit the timeline only when
    /// the flag is on". The faux provider never invokes the payload hook,
    /// so request-sent is absent and its deltas are omitted (the TS
    /// omission shape); the engine wires the instrumented seams from the
    /// `requestTiming` settings key.
    #[tokio::test]
    async fn engine_sessions_emit_the_timeline_only_when_the_flag_is_on() {
        use crate::session_engine::engine::{create_session, SessionEngineConfig};
        use crate::session_engine::provider_adapter::{json_round_trip, real_stream_fn};

        // The engine reads the env half of the flag at session build, so the
        // ambient/parallel-test env is pinned for the duration (TS deletes
        // `PI_REQUEST_TIMING` in `beforeEach` for the same isolation).
        let _env = REQUEST_TIMING_ENV_LOCK.lock().await;
        let previous_env = std::env::var(REQUEST_TIMING_ENV).ok();
        std::env::remove_var(REQUEST_TIMING_ENV);

        let dir = tempfile::tempdir().unwrap();
        let agent_dir = dir.path().join("agent");
        std::fs::create_dir_all(&agent_dir).unwrap();
        // Settings-sourced flag: the global settings.json the engine reads.
        std::fs::write(
            agent_dir.join("settings.json"),
            r#"{"requestTiming": true}"#,
        )
        .unwrap();

        let registration =
            pa_ai::faux::register_faux_provider(pa_ai::faux::RegisterFauxProviderOptions {
                api: Some("request-timing-faux".to_string()),
                provider: Some("faux-bench".to_string()),
                models: Some(vec![pa_ai::faux::FauxModelDefinition {
                    id: "faux-1".to_string(),
                    name: Some("Faux".to_string()),
                    reasoning: Some(false),
                    input: Some(vec![pa_types::ai::ModelInput::Text]),
                    cost: None,
                    context_window: Some(100_000),
                    max_tokens: Some(4_096),
                }]),
                ..Default::default()
            });
        registration.set_responses(vec![pa_ai::faux::FauxResponseStep::Message(
            pa_ai::faux::faux_assistant_text_message(
                "ok",
                pa_ai::faux::FauxAssistantMessageOptions::default(),
            ),
        )]);
        let model = registration.get_model();
        let agent_model = json_round_trip(&model).unwrap();
        let stream_fn = real_stream_fn(None, model.clone());
        let engine = create_session(SessionEngineConfig {
            cwd: dir.path().to_path_buf(),
            agent_dir: agent_dir.clone(),
            model: Some(agent_model),
            stream_fn: Some(stream_fn),
            tools: Vec::new(),
            ..Default::default()
        })
        .await
        .unwrap();
        engine
            .session
            .prompt("hello", crate::session_engine::PromptOptions::default())
            .await
            .unwrap();
        engine.session.agent().wait_for_idle().await;

        let entries = timing_entries(&agent_dir.join("logs").join("agent.jsonl"));
        assert_eq!(
            phases_of(&entries).join(","),
            "prompt-built,first-byte,first-token,stream-done",
            "faux never calls the payload hook, so request-sent is omitted: {entries:?}"
        );
        let summary = entries.last().expect("summary entry");
        assert_eq!(summary.get("outcome"), Some(&json!("done")));
        assert_eq!(
            summary.get("model").and_then(Value::as_str),
            Some("faux-1"),
            "the entry carries the loop model id: {summary}"
        );
        assert_eq!(
            summary.get("provider").and_then(Value::as_str),
            Some("faux-bench")
        );
        assert!(
            summary.get("requestBytes").is_none(),
            "no payload hook ran, so no bytes were measured: {summary}"
        );
        let phases = summary.get("phases").expect("phases object");
        assert!(
            phases.get("requestSentToFirstByteMs").is_none()
                && phases.get("promptBuiltToRequestSentMs").is_none(),
            "unmeasured deltas are omitted: {phases}"
        );
        assert!(
            phases.get("dispatchToPromptBuiltMs").is_some(),
            "the dispatch seam ran: {phases}"
        );

        // Flag off: no entries at all (the registration stays live for the
        // second session's request; it unregisters below).
        registration.set_responses(vec![pa_ai::faux::FauxResponseStep::Message(
            pa_ai::faux::faux_assistant_text_message(
                "ok",
                pa_ai::faux::FauxAssistantMessageOptions::default(),
            ),
        )]);
        let off_dir = tempfile::tempdir().unwrap();
        let engine = create_session(SessionEngineConfig {
            cwd: off_dir.path().to_path_buf(),
            agent_dir: off_dir.path().to_path_buf(),
            model: Some(json_round_trip(&model).unwrap()),
            stream_fn: Some(real_stream_fn(None, model.clone())),
            tools: Vec::new(),
            ..Default::default()
        })
        .await
        .unwrap();
        engine
            .session
            .prompt("hello", crate::session_engine::PromptOptions::default())
            .await
            .unwrap();
        engine.session.agent().wait_for_idle().await;
        registration.unregister();
        assert!(
            timing_entries(&off_dir.path().join("logs").join("agent.jsonl")).is_empty(),
            "flag off writes no entries"
        );
        match previous_env {
            Some(value) => std::env::set_var(REQUEST_TIMING_ENV, value),
            None => std::env::remove_var(REQUEST_TIMING_ENV),
        }
    }
}
