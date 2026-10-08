//! The stream wrapper that binds one session's recorder to its provider
//! turns (TS `wrapStreamFnWithSemanticEdges`).

use std::collections::BTreeMap;
use std::sync::Arc;

use pa_agent::stream::{
    AssistantMessageEvent, LlmContext, ModelStream, StreamFn, StreamRequestOptions,
};
use pa_agent::types::{AssistantMessage, Model, StopReason};
use sha2::{Digest as _, Sha256};

use super::{model_request_headers, SemanticEdgeRecorder};

/// Bind a stream function to one session's recorder (TS
/// `wrapStreamFnWithSemanticEdges`; the Rust engine wraps it OUTERMOST,
/// over the timing-instrumented fn). `request_started` is appended before
/// the wire call; the request commits or fails when its stream resolves
/// (an error/aborted final message is a failure). A disabled recorder
/// leaves the call untouched: no id, no headers, no event.
pub(crate) fn wrap_stream_fn(recorder: Arc<SemanticEdgeRecorder>, inner: StreamFn) -> StreamFn {
    Arc::new(move |model, context, mut options| {
        let recorder = Arc::clone(&recorder);
        let inner = Arc::clone(&inner);
        Box::pin(async move {
            let fingerprint = turn_fingerprint(&model, &context, &options);
            let Some(request_id) = recorder.start_turn_request(fingerprint) else {
                return inner(model, context, options).await;
            };
            let headers = options.headers.get_or_insert_with(BTreeMap::new);
            headers.extend(model_request_headers(&request_id));
            match inner(model, context, options).await {
                Err(error) => {
                    recorder.fail_request(&request_id);
                    Err(error)
                }
                Ok(stream) => Ok(Box::new(SemanticStream {
                    inner: stream,
                    recorder,
                    request_id,
                    settled: false,
                }) as Box<dyn ModelStream>),
            }
        })
    })
}

/// A provider stream observed by the recorder: `result()` settles the
/// request by its final stop reason, and an unsettled stream fails at
/// `close()` or drop — TS observes an abort as a failed request, not a
/// stuck in-flight one.
struct SemanticStream {
    inner: Box<dyn ModelStream>,
    recorder: Arc<SemanticEdgeRecorder>,
    request_id: String,
    settled: bool,
}

impl SemanticStream {
    /// Settle a resolved stream by its final stop reason (TS observe: an
    /// error/aborted final message is a failed request).
    fn settle_by_stop_reason(&mut self, message: &AssistantMessage) {
        if self.settled {
            return;
        }
        self.settled = true;
        if matches!(message.stop_reason, StopReason::Error | StopReason::Aborted) {
            self.recorder.fail_request(&self.request_id);
        } else {
            self.recorder.finish_request(&self.request_id);
        }
    }

    /// Settle an unresolved stream as failed (a rejected result, a close,
    /// or the drop).
    fn fail(&mut self) {
        if self.settled {
            return;
        }
        self.settled = true;
        self.recorder.fail_request(&self.request_id);
    }
}

impl ModelStream for SemanticStream {
    fn next_event(&mut self) -> pa_agent::BoxFut<'_, Option<AssistantMessageEvent>> {
        self.inner.next_event()
    }

    fn result(&mut self) -> pa_agent::BoxFut<'_, anyhow::Result<AssistantMessage>> {
        Box::pin(async move {
            let message = self.inner.result().await;
            match &message {
                Ok(message) => self.settle_by_stop_reason(message),
                Err(_) => self.fail(),
            }
            message
        })
    }

    fn close(&mut self) {
        self.fail();
        self.inner.close();
    }
}

impl Drop for SemanticStream {
    fn drop(&mut self) {
        self.fail();
    }
}

fn sha256(bytes: &[u8]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hasher.finalize().into()
}

/// sha256 over the canonical JSON of one fingerprint input (TS
/// `digestJson`).
fn digest_json(value: &impl serde::Serialize) -> [u8; 32] {
    sha256(&serde_json::to_vec(value).unwrap_or_default())
}

/// Fingerprint of one turn call body (TS `hashTurnBody`, in-memory only —
/// never on disk): the recorder reuses a parked retry's id only for an
/// equal fingerprint. It hashes a bounded subset (model, options,
/// system-prompt digest, message count, last-message digest, tools
/// digest) so the full body is never re-serialized per request; the
/// fingerprint only gates parked-retry id reuse within one retry window.
fn turn_fingerprint(
    model: &Model,
    context: &LlmContext,
    options: &StreamRequestOptions,
) -> [u8; 32] {
    let body = serde_json::json!({
        "provider": model.provider,
        "model": model.id,
        "reasoning": options.reasoning,
        "temperature": options.temperature,
        "maxTokens": options.max_tokens,
        "serviceTier": options.service_tier,
        "systemPromptDigest": context
            .system_prompt
            .as_deref()
            .map(|prompt| sha256(prompt.as_bytes())),
        "messageCount": context.messages.len(),
        "lastMessageDigest": context.messages.last().map(digest_json),
        "toolsDigest": digest_json(&context.tools),
    });
    sha256(&serde_json::to_vec(&body).unwrap_or_default())
}
