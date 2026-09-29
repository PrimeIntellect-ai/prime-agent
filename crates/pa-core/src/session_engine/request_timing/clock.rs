//! The per-request clock concern (moved with its concern): the request
//! identity + usage records (`RequestInfo`, `TimingUsage` with its From
//! impl moving whole), the outcome + timing state machine, and the phase
//! entries' emit (TS `RequestTiming`).

use super::{
    elapsed_ms, json, round_ms, Instant, Map, Mutex, PromptBuildTiming, RequestTimingLog,
    StreamRequestOptions, Value,
};
use pa_agent::types::Usage;

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
pub(super) enum Outcome {
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
pub(super) struct RequestTiming {
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
    pub(super) fn new(
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
    pub(super) fn mark_request_sent(&self) {
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
    pub(super) fn record_request_bytes(&self, request_bytes: Option<u64>) {
        self.inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .request_bytes = request_bytes;
    }

    /// first-byte: HTTP response headers received (provider TTFB complete).
    pub(super) fn mark_first_byte(&self) {
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
    pub(super) fn mark_first_token(&self) {
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
    pub(super) fn mark_stream_done(&self, stop_reason: String, error_message: Option<String>) {
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
    pub(super) fn mark_usage(&self, usage: &Usage) {
        self.inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .usage = Some(TimingUsage::from(usage));
    }

    /// Emit the summary with every known phase delta (TS `emitSummary`).
    /// Safe to call once; later calls are ignored.
    pub(super) fn emit_summary(&self, outcome: Outcome) {
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
