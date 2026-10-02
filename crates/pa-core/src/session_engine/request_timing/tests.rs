//! The request-timing unit battery (moved with its concern): the flag,
//! the log's rotation + emit shape, the wiring correlation, the transform
//! and convert instrumentation, the stream seam's first-token capture, and
//! the summary's usage fields (the TS test port).

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
/// `WeakMap` lookup on its never-marked array returns nothing, so the
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
            Some(&json!({"input": 800_000, "output": 12, "cacheRead": 790_000, "cacheWrite": 0})),
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
        crate::settings::SettingsManager::in_memory(&settings).get_request_timing(),
        "the getter reads the merged flag"
    );
    assert!(
        !crate::settings::SettingsManager::in_memory(&crate::settings::Settings::default())
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

/// A provider seam that invokes the payload hook once with the TS
/// `PAYLOAD` fixture, then settles with a zero-usage message (the pin is
/// the capture, not the turn). Unix-only like its callers: the capture
/// the payload tests prove is Unix-only by the confidentiality design.
#[cfg(unix)]
fn payload_calling_provider() -> StreamFn {
    Arc::new(move |model, _context, options| {
        Box::pin(async move {
            if let Some(on_payload) = options.on_payload.as_ref() {
                let _ = on_payload(payload(), &model);
            }
            let (handle, consumer) = event_stream();
            let final_msg = empty_partial(&model);
            tokio::spawn(async move {
                handle.push(AssistantMessageEvent::Start {
                    partial: final_msg.clone(),
                });
                handle.push(AssistantMessageEvent::Done {
                    reason: StopReason::Stop,
                    message: final_msg,
                });
            });
            Ok(Box::new(consumer) as Box<dyn ModelStream>)
        })
    })
}

/// The capture integration: while the flag is on, the instrumented
/// payload hook hands the request's final outbound body — after every
/// transform, exactly what the provider sees — to the capture's writer,
/// with the identity fields the timeline entries correlate by.
#[cfg(unix)]
#[tokio::test]
async fn the_payload_capture_writes_the_exact_outbound_body() {
    let _writer_lock = super::payload::WRITER_TEST_LOCK.lock().await;
    let dir = tempfile::tempdir().unwrap();
    let log_path = dir.path().join("agent.jsonl");
    let capture_dir = dir.path().join("request-payloads");
    let wiring = Arc::new(
        RequestTimingWiring::new(Arc::new(|| true), RequestTimingLog::at(&log_path))
            .with_payload_capture(RequestPayloadCapture::at(&capture_dir, 64)),
    );
    let stream = run_timed_request(
        Arc::clone(&wiring),
        scripted_provider(test_model(), gate().1, gate().1, gate().1, false),
    )
    .await
    .unwrap();
    drain(stream).await;

    super::payload::tests::wait_for_payload_files(&capture_dir, 1);
    let names = super::payload::tests::payload_files(&capture_dir);
    let envelope = super::payload::tests::payload_envelope(&capture_dir, &names[0]);
    assert_eq!(
        envelope.get("payload"),
        Some(&payload()),
        "the file carries the exact outbound body: {envelope}"
    );
    assert_eq!(
        envelope.get("model").and_then(Value::as_str),
        Some("bench/bench-model")
    );
    assert_eq!(
        envelope.get("provider").and_then(Value::as_str),
        Some("bench")
    );
    assert_eq!(envelope.get("sessionId"), Some(&json!("sess-timing")));
    assert_eq!(envelope.get("requestSeq"), Some(&json!(1)));
    assert_eq!(
        envelope.get("requestBytes"),
        Some(&json!(serde_json::to_vec(&payload()).unwrap().len() as u64)),
        "UTF-8 bytes, not a code-unit count: {envelope}"
    );
    // The timeline still emits: the capture rides the same flag.
    assert!(
        timing_entries(&log_path)
            .iter()
            .any(|entry| { entry.get("phase").and_then(Value::as_str) == Some("request-sent") }),
        "the phase timeline is unchanged"
    );
}

/// The capture rides the request-timing flag: disabled, the same request
/// hands off no body (and writes no timeline entry).
#[cfg(unix)]
#[tokio::test]
async fn the_payload_capture_writes_nothing_when_the_flag_is_off() {
    let dir = tempfile::tempdir().unwrap();
    let log_path = dir.path().join("agent.jsonl");
    let capture_dir = dir.path().join("request-payloads");
    let wiring = Arc::new(
        RequestTimingWiring::new(Arc::new(|| false), RequestTimingLog::at(&log_path))
            .with_payload_capture(RequestPayloadCapture::at(&capture_dir, 64)),
    );
    let stream = run_timed_request(
        Arc::clone(&wiring),
        scripted_provider(test_model(), gate().1, gate().1, gate().1, false),
    )
    .await
    .unwrap();
    drain(stream).await;
    assert!(
        super::payload::tests::payload_files(&capture_dir).is_empty(),
        "flag off captures no bodies"
    );
    assert!(
        timing_entries(&log_path).is_empty(),
        "flag off writes no entries"
    );
}

/// The engine path (the daemon workers' session build is this same
/// `create_session`): the wiring the engine installs captures while the
/// flag is on, and writes nothing while it is off.
#[cfg(unix)]
#[tokio::test]
async fn engine_sessions_capture_the_outbound_payload_when_the_flag_is_on() {
    use crate::session_engine::engine::{create_session, SessionEngineConfig};

    // Both shared-process locks: the env pin and the writer queue.
    let _writer_lock = super::payload::WRITER_TEST_LOCK.lock().await;
    let _env = REQUEST_TIMING_ENV_LOCK.lock().await;
    let previous_env = std::env::var(REQUEST_TIMING_ENV).ok();
    std::env::remove_var(REQUEST_TIMING_ENV);

    let dir = tempfile::tempdir().unwrap();
    let agent_dir = dir.path().join("agent");
    std::fs::create_dir_all(&agent_dir).unwrap();
    std::fs::write(
        agent_dir.join("settings.json"),
        r#"{"requestTiming": true}"#,
    )
    .unwrap();

    let engine = create_session(SessionEngineConfig {
        cwd: dir.path().to_path_buf(),
        agent_dir: agent_dir.clone(),
        model: Some(test_model()),
        stream_fn: Some(payload_calling_provider()),
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

    let capture_dir = agent_dir.join("logs").join("request-payloads");
    super::payload::tests::wait_for_payload_files(&capture_dir, 1);
    let names = super::payload::tests::payload_files(&capture_dir);
    let envelope = super::payload::tests::payload_envelope(&capture_dir, &names[0]);
    assert_eq!(
        envelope.get("payload"),
        Some(&payload()),
        "the engine's capture carries the exact outbound body: {envelope}"
    );
    assert_eq!(
        envelope.get("model").and_then(Value::as_str),
        Some("bench/bench-model")
    );

    // Flag off: no capture directory at all (the wrapper passes
    // straight through with no serialization and no writes).
    let off_dir = tempfile::tempdir().unwrap();
    let engine = create_session(SessionEngineConfig {
        cwd: off_dir.path().to_path_buf(),
        agent_dir: off_dir.path().to_path_buf(),
        model: Some(test_model()),
        stream_fn: Some(payload_calling_provider()),
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
    let off_capture = off_dir.path().join("logs").join("request-payloads");
    assert!(
        super::payload::tests::payload_files(&off_capture).is_empty() && !off_capture.exists(),
        "flag off leaves no capture"
    );
    match previous_env {
        Some(value) => std::env::set_var(REQUEST_TIMING_ENV, value),
        None => std::env::remove_var(REQUEST_TIMING_ENV),
    }
}
