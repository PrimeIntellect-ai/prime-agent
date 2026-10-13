//! The semantic-edge recorder battery: the ledger lifecycle and replay,
//! retry parking, the torn-tail rule, and the stream wrapper.

use std::sync::{Arc, Mutex};

use pa_agent::stream::{
    AssistantMessageEvent, LlmContext, ModelStream, StreamFn, StreamRequestOptions,
};
use pa_agent::types::{AssistantMessage, Model, StopReason, Usage};
use tempfile::TempDir;

use super::{
    model_request_headers, wrap_stream_fn, SemanticEdgeIdentity, SemanticEdgeLedgerEvent,
    SemanticEdgeRecorder, IDEMPOTENCY_KEY_HEADER, MODEL_REQUEST_ID_HEADER,
};

const FINGERPRINT_A: [u8; 32] = [1; 32];
const FINGERPRINT_B: [u8; 32] = [2; 32];

/// One identity over a fresh tempdir ledger.
fn identity(session_id: &str) -> (SemanticEdgeIdentity, TempDir) {
    let dir = TempDir::new().unwrap();
    let identity = SemanticEdgeIdentity {
        session_id: session_id.to_string(),
        ledger_path: Some(dir.path().join(super::SEMANTIC_EDGES_LEDGER_FILENAME)),
        parent_session_id: Some("parent-session".to_string()),
        spawned_by_request_id: Some("parent-request".to_string()),
    };
    (identity, dir)
}

fn read_ledger(identity: &SemanticEdgeIdentity) -> Vec<SemanticEdgeLedgerEvent> {
    super::ledger::read_events(identity.ledger_path.as_ref().unwrap())
        .unwrap()
        .unwrap_or_default()
}

fn session_registered(session_id: &str) -> SemanticEdgeLedgerEvent {
    SemanticEdgeLedgerEvent::SessionRegistered {
        session_id: session_id.to_string(),
        parent_session_id: Some("parent-session".to_string()),
        spawned_by_request_id: Some("parent-request".to_string()),
    }
}

fn request_started(session_id: &str, request_id: &str) -> SemanticEdgeLedgerEvent {
    SemanticEdgeLedgerEvent::RequestStarted {
        request_id: request_id.to_string(),
        session_id: session_id.to_string(),
        compaction_id: None,
    }
}

fn request_started_slice(
    session_id: &str,
    compaction_id: &str,
    request_id: &str,
) -> SemanticEdgeLedgerEvent {
    SemanticEdgeLedgerEvent::RequestStarted {
        request_id: request_id.to_string(),
        session_id: session_id.to_string(),
        compaction_id: Some(compaction_id.to_string()),
    }
}

#[test]
fn a_turn_lifecycle_is_ledgered_and_reopening_replays_without_reregistering() {
    let (identity, _dir) = identity("session-a");
    let recorder = SemanticEdgeRecorder::open(identity.clone());
    let first = recorder
        .start_turn_request(FINGERPRINT_A)
        .expect("the recorder mints ids");
    recorder.finish_request(&first);
    let second = recorder
        .start_turn_request(FINGERPRINT_A)
        .expect("the recorder mints ids");
    recorder.fail_request(&second);
    drop(recorder);
    // Reopen: the ledger replays without re-registering, and the last
    // replayed request_started restores the in-flight turn a resumed
    // child's spawn anchors to.
    let reopened = SemanticEdgeRecorder::open(identity.clone());
    assert_eq!(
        reopened.last_turn_request_id().as_deref(),
        Some(second.as_str())
    );
    assert_eq!(
        read_ledger(&identity),
        vec![
            session_registered("session-a"),
            request_started("session-a", &first),
            SemanticEdgeLedgerEvent::RequestFinished {
                request_id: first.clone(),
            },
            request_started("session-a", &second),
            SemanticEdgeLedgerEvent::RequestFailed { request_id: second },
        ]
    );
}

#[test]
fn a_parked_retry_reuses_its_id_only_for_an_identical_body_in_the_same_epoch() {
    let (identity, _dir) = identity("session-b");
    let recorder = Arc::new(SemanticEdgeRecorder::open(identity.clone()));
    let first = recorder
        .start_turn_request(FINGERPRINT_A)
        .expect("the recorder mints ids");
    // The parked retry reuses the id for the identical body and re-logs
    // its request_started; a different body mints a fresh id.
    recorder.prepare_turn_retry();
    assert_eq!(
        recorder.start_turn_request(FINGERPRINT_A).as_deref(),
        Some(first.as_str())
    );
    let different_body = recorder
        .start_turn_request(FINGERPRINT_B)
        .expect("the recorder mints ids");
    assert_ne!(different_body, first);
    // A completed compaction bumps the epoch: a parked id from the old
    // epoch is not reused even for an identical body.
    recorder.begin_compaction(None).commit();
    recorder.prepare_turn_retry();
    let post_compaction = recorder
        .start_turn_request(FINGERPRINT_B)
        .expect("the recorder mints ids");
    assert_ne!(post_compaction, different_body);
    let ledger = read_ledger(&identity);
    let compaction_id = ledger
        .iter()
        .find_map(|event| match event {
            SemanticEdgeLedgerEvent::CompactionBegun { compaction_id, .. } => {
                Some(compaction_id.clone())
            }
            _ => None,
        })
        .expect("the compaction began");
    assert_eq!(
        ledger,
        vec![
            session_registered("session-b"),
            request_started("session-b", &first),
            request_started("session-b", &first),
            request_started("session-b", &different_body),
            SemanticEdgeLedgerEvent::CompactionBegun {
                compaction_id: compaction_id.clone(),
                session_id: "session-b".to_string(),
            },
            SemanticEdgeLedgerEvent::CompactionFinished {
                compaction_id,
                status: super::CompactionStatus::Completed,
            },
            request_started("session-b", &post_compaction),
        ]
    );
}

#[tokio::test]
async fn split_summary_slices_commit_in_resolve_order() {
    let (identity, _dir) = identity("session-g");
    let recorder = Arc::new(SemanticEdgeRecorder::open(identity.clone()));
    let mut compaction = recorder.begin_compaction(None);
    let (release_first, first_gate) = tokio::sync::oneshot::channel::<()>();
    let mut first = Box::pin(super::summary_slice_call(
        Some(&compaction),
        None,
        move |_| async move {
            let _gate = first_gate.await;
            Ok::<(), anyhow::Error>(())
        },
    ));
    // The first slice starts (ledger) and parks on its gate; the second
    // starts and resolves while the first is still in flight.
    assert!(futures::poll!(first.as_mut()).is_pending());
    super::summary_slice_call(Some(&compaction), None, |_| async {
        Ok::<(), anyhow::Error>(())
    })
    .await
    .expect("the second slice resolves");
    release_first.send(()).expect("the parked slice's gate");
    first.await.expect("the parked slice resolves");
    compaction.commit();
    // The started ids in start order; commit finishes them in resolve
    // order (TS pushes `uncommittedSlices` on resolve): b then a.
    let ledger = read_ledger(&identity);
    let compaction_id = ledger
        .iter()
        .find_map(|event| match event {
            SemanticEdgeLedgerEvent::CompactionBegun { compaction_id, .. } => {
                Some(compaction_id.clone())
            }
            _ => None,
        })
        .expect("the compaction began");
    let slices: Vec<String> = ledger
        .iter()
        .filter_map(|event| match event {
            SemanticEdgeLedgerEvent::RequestStarted {
                request_id,
                compaction_id: Some(_),
                ..
            } => Some(request_id.clone()),
            _ => None,
        })
        .collect();
    let (a, b) = (&slices[0], &slices[1]);
    assert_eq!(
        read_ledger(&identity),
        vec![
            session_registered("session-g"),
            SemanticEdgeLedgerEvent::CompactionBegun {
                compaction_id: compaction_id.clone(),
                session_id: "session-g".to_string(),
            },
            request_started_slice("session-g", &compaction_id, a),
            request_started_slice("session-g", &compaction_id, b),
            SemanticEdgeLedgerEvent::RequestFinished {
                request_id: b.clone()
            },
            SemanticEdgeLedgerEvent::RequestFinished {
                request_id: a.clone()
            },
            SemanticEdgeLedgerEvent::CompactionFinished {
                compaction_id,
                status: super::CompactionStatus::Completed,
            },
        ]
    );
}

#[test]
fn a_ledger_failure_drops_the_spawn_anchor() {
    let (identity, _dir) = identity("session-e");
    let recorder = SemanticEdgeRecorder::open(identity.clone());
    recorder
        .start_turn_request(FINGERPRINT_A)
        .expect("the recorder mints ids");
    // A directory at the ledger path fails the next append (works as
    // root too).
    let path = identity.ledger_path.as_ref().unwrap();
    std::fs::remove_file(path).unwrap();
    std::fs::create_dir(path).unwrap();
    assert_eq!(
        (
            recorder.start_turn_request(FINGERPRINT_B),
            recorder.last_turn_request_id()
        ),
        (None, None)
    );
}

#[test]
fn a_torn_final_line_is_ignored_on_replay_and_truncated_before_the_next_append() {
    let (identity, _dir) = identity("session-c");
    let registered = session_registered("session-c");
    let mut torn = serde_json::to_string(&registered).unwrap();
    torn.push('\n');
    torn.push_str("{\"type\":\"request_st");
    std::fs::write(identity.ledger_path.as_ref().unwrap(), torn).unwrap();
    // The replay skips the unterminated final line even though its prefix
    // parses: no turn is restored.
    let recorder = SemanticEdgeRecorder::open(identity.clone());
    assert_eq!(recorder.last_turn_request_id(), None);
    let request_id = recorder
        .start_turn_request(FINGERPRINT_A)
        .expect("the recorder mints ids");
    // The append truncated the torn tail at its byte offset first: the
    // file bytes are exactly the registered line and the new event.
    let mut expected = serde_json::to_string(&registered).unwrap().into_bytes();
    expected.push(b'\n');
    expected.extend(
        serde_json::to_string(&request_started("session-c", &request_id))
            .unwrap()
            .into_bytes(),
    );
    expected.push(b'\n');
    let bytes = std::fs::read(identity.ledger_path.as_ref().unwrap()).unwrap();
    assert_eq!(bytes, expected);
}

/// A stream fn that records the request options and serves the scripted
/// events as one stream (an empty script serves a closed, unsettled
/// stream).
fn capturing_stream_fn(
    events: Vec<AssistantMessageEvent>,
) -> (Arc<Mutex<Vec<StreamRequestOptions>>>, StreamFn) {
    let captured: Arc<Mutex<Vec<StreamRequestOptions>>> = Arc::new(Mutex::new(Vec::new()));
    let stream_fn: StreamFn = {
        let captured = Arc::clone(&captured);
        Arc::new(move |_model, _context, options| {
            let captured = Arc::clone(&captured);
            let events = events.clone();
            Box::pin(async move {
                captured.lock().unwrap().push(options);
                let (handle, stream) = pa_agent::stream::event_stream();
                for event in events {
                    handle.push(event);
                }
                handle.end(None);
                Ok(Box::new(stream) as Box<dyn ModelStream>)
            })
        })
    };
    (captured, stream_fn)
}

fn terminal_event(reason: StopReason) -> AssistantMessageEvent {
    let message = AssistantMessage {
        content: Vec::new(),
        api: "test".to_string(),
        provider: "test".to_string(),
        model: "m".to_string(),
        response_model: None,
        response_id: None,
        diagnostics: None,
        usage: Usage::zero(),
        stop_reason: reason,
        stop_reason_raw: None,
        error_message: None,
        timestamp: 0,
    };
    match reason {
        StopReason::Error | StopReason::Aborted => AssistantMessageEvent::Error {
            reason,
            error: message,
        },
        _ => AssistantMessageEvent::Done { reason, message },
    }
}

/// The request id a wrapped call carried (both headers present, equal).
fn bound_request_id(captured: &Mutex<Vec<StreamRequestOptions>>) -> String {
    let options = captured.lock().unwrap().first().expect("one call").clone();
    let headers = options.headers.expect("the wrapped call carries headers");
    let id = headers
        .get(MODEL_REQUEST_ID_HEADER)
        .expect("the request-id header");
    assert_eq!(
        id,
        headers
            .get(IDEMPOTENCY_KEY_HEADER)
            .expect("the idempotency key")
    );
    assert_eq!(headers, model_request_headers(id));
    id.clone()
}

async fn wrapped_call(
    recorder: &Arc<SemanticEdgeRecorder>,
    inner: StreamFn,
) -> Box<dyn ModelStream> {
    wrap_stream_fn(Arc::clone(recorder), inner)(
        Model::unknown(),
        LlmContext::default(),
        StreamRequestOptions::default(),
    )
    .await
    .expect("the wrapped stream starts")
}

#[tokio::test]
async fn turn_requests_carry_both_headers_and_settle_by_stop_reason() {
    let (identity, _dir) = identity("session-d");
    let recorder = Arc::new(SemanticEdgeRecorder::open(identity.clone()));
    // A stop stream commits, an error stream fails, and a dropped
    // unsettled stream fails.
    let (captured_stop, stop_fn) = capturing_stream_fn(vec![terminal_event(StopReason::Stop)]);
    let (captured_error, error_fn) = capturing_stream_fn(vec![terminal_event(StopReason::Error)]);
    let (captured_dropped, dropped_fn) = capturing_stream_fn(Vec::new());
    let committed_id = {
        let mut stream = wrapped_call(&recorder, stop_fn).await;
        stream.result().await.expect("the stop result");
        bound_request_id(&captured_stop)
    };
    let failed_id = {
        let mut stream = wrapped_call(&recorder, error_fn).await;
        stream.result().await.expect("the error result");
        bound_request_id(&captured_error)
    };
    let dropped_id = {
        let stream = wrapped_call(&recorder, dropped_fn).await;
        let id = bound_request_id(&captured_dropped);
        drop(stream);
        id
    };
    assert_eq!(
        read_ledger(&identity),
        vec![
            session_registered("session-d"),
            request_started("session-d", &committed_id),
            SemanticEdgeLedgerEvent::RequestFinished {
                request_id: committed_id,
            },
            request_started("session-d", &failed_id),
            SemanticEdgeLedgerEvent::RequestFailed {
                request_id: failed_id,
            },
            request_started("session-d", &dropped_id),
            SemanticEdgeLedgerEvent::RequestFailed {
                request_id: dropped_id,
            },
        ]
    );
}
