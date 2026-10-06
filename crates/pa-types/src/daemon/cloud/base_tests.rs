//! Wire goldens for the base cloud protocol slice: round trips for every
//! frame/command/event kind, cursor and selector semantics, digest shape,
//! and spot checks of the validator problem strings (the full matrix lives
//! in the TS-recorded golden corpus, `tests/cloud_protocol_golden.rs`).

use serde_json::{json, Value};

use super::*;

/// Parse-serialize-reparse: the typed form must round-trip the wire value
/// without changing it (the `daemon::rt` pattern).
fn rt<T: serde::Serialize + for<'de> serde::Deserialize<'de>>(wire: &str) {
    let original: Value = serde_json::from_str(wire).unwrap();
    let parsed: T = serde_json::from_str(wire).expect("deserialize");
    let out = serde_json::to_string(&parsed).expect("serialize");
    let reparsed: Value = serde_json::from_str(&out).unwrap();
    assert_eq!(original, reparsed, "round trip changed the value: {out}");
}

const RECEIPT: &str = r#"{"commandId":"cmd_1","digest":"sha256:e7dfe480c4463263a93755ec83d15829b19df0698e8b764baa4b5e9a3d7bc727","state":"accepted","submittedAt":"2026-09-29T00:00:00.000Z","updatedAt":"2026-09-29T00:00:00.001Z","uncertain":false}"#;

#[test]
fn frame_round_trips() {
    rt::<CloudMessage>(
        r#"{"type":"hello","protocolVersion":3,"generation":1,"clientId":"client_1","sessionId":"sess_1"}"#,
    );
    rt::<CloudMessage>(
        r#"{"type":"hello","protocolVersion":3,"generation":2,"clientId":"client_1","sessionId":"sess_1","authToken":"tok_1","cursor":{"generation":2,"sequence":7},"capabilities":["event_stream","family_messages"]}"#,
    );
    rt::<CloudMessage>(
        r#"{"type":"snapshot","sessionId":"sess_1","generation":2,"cursor":{"generation":2,"sequence":0},"status":"idle","state":{"cwd":"/work","modelId":"prime-inference/internal/glm-5.3-fast","queuedCommandIds":[]},"events":[]}"#,
    );
    rt::<CloudMessage>(
        r#"{"type":"snapshot","sessionId":"sess_1","generation":2,"cursor":{"generation":2,"sequence":2},"status":"busy","state":{"cwd":"/work","modelId":"m/x","activeCommandId":"cmd_1","queuedCommandIds":["cmd_2","cmd_3"]},"events":[{"sequence":1,"kind":"session_status","recordedAt":"2026-09-29T00:00:00.000Z","status":"busy"},{"sequence":2,"kind":"output_delta","recordedAt":"2026-09-29T00:00:00.001Z","taskId":"task_1","stream":"stderr","text":""}],"capabilities":["event_stream"]}"#,
    );
    rt::<CloudMessage>(
        r#"{"type":"subscribe","sessionId":"sess_1","cursor":{"generation":1,"sequence":3}}"#,
    );
    rt::<CloudMessage>(
        r#"{"type":"events","sessionId":"sess_1","generation":1,"events":[{"sequence":4,"kind":"session_status","recordedAt":"2026-09-29T00:00:00.002Z","status":"busy"}]}"#,
    );
    rt::<CloudMessage>(r#"{"type":"get_command","sessionId":"sess_1","generation":1}"#);
    rt::<CloudMessage>(
        r#"{"type":"get_command","sessionId":"sess_1","generation":1,"commandId":"cmd_1"}"#,
    );
    rt::<CloudMessage>(
        r#"{"type":"get_command","sessionId":"sess_1","generation":1,"claim":true}"#,
    );
    rt::<CloudMessage>(
        r#"{"type":"ack","sessionId":"sess_1","cursor":{"generation":1,"sequence":9}}"#,
    );
    rt::<CloudMessage>(
        r#"{"type":"inference_request","sessionId":"sess_1","remoteSessionId":"remote_1","requestId":"inf_1","model":{"provider":"prime-inference","modelId":"internal/glm-5.3-fast"},"payload":{"messages":[{"role":"user","content":"hi"}],"options":{"temperature":0.5}}}"#,
    );
    rt::<CloudMessage>(
        r#"{"type":"inference_request","sessionId":"sess_1","remoteSessionId":"remote_1","requestId":"inf_1","model":{"provider":"openai","modelId":"gpt-5.5"},"thinking":"high","payload":{"messages":[]}}"#,
    );
    rt::<CloudMessage>(
        r#"{"type":"inference_event","sessionId":"sess_1","requestId":"inf_1","event":{"type":"message_start"}}"#,
    );
    rt::<CloudMessage>(
        r#"{"type":"inference_end","sessionId":"sess_1","requestId":"inf_1","message":{"role":"assistant","content":"done"}}"#,
    );
    rt::<CloudMessage>(
        r#"{"type":"inference_error","sessionId":"sess_1","requestId":"inf_1","error":"rate limited"}"#,
    );
}

#[test]
fn command_and_command_frame_round_trips() {
    rt::<CloudMessage>(
        format!(r#"{{"type":"command","sessionId":"sess_1","generation":1,"receipt":{RECEIPT}}}"#)
            .as_str(),
    );
    rt::<CloudMessage>(
        format!(
            r#"{{"type":"command","sessionId":"sess_1","generation":1,"receipt":{RECEIPT},"request":"{{\"kind\":\"prompt\",\"text\":\"hi\"}}"}}"#
        )
        .as_str(),
    );
    rt::<CloudCommandRequest>(r#"{"kind":"open_session","cwd":"/work"}"#);
    rt::<CloudCommandRequest>(
        r#"{"kind":"open_session","cwd":"/work","model":"prime-inference/internal/glm-5.3-fast","thinking":"high","seedTranscriptArtifact":"art://seed","prompt":"start","family":{"depth":1,"parentSessionId":"sess_local","parentSessionFile":"/sessions/local.jsonl","parentName":"root"},"modelMetadata":{"name":"GLM 5.3","contextWindow":128000,"maxTokens":16384,"reasoning":true}}"#,
    );
    rt::<CloudCommandRequest>(
        r#"{"kind":"prompt","text":"hi","queueIfBusy":true,"targetSessionId":"remote_child"}"#,
    );
    rt::<CloudCommandRequest>(r#"{"kind":"prompt","text":"hi"}"#);
    rt::<CloudCommandRequest>(r#"{"kind":"steer","text":"stop"}"#);
    rt::<CloudCommandRequest>(r#"{"kind":"follow_up","text":"more"}"#);
    rt::<CloudCommandRequest>(r#"{"kind":"abort"}"#);
    rt::<CloudCommandRequest>(r#"{"kind":"release"}"#);
    rt::<CloudCommandRequest>(
        r#"{"kind":"send_message","targetRemoteSessionId":"remote_child","message":"status update","messageId":"agentmsg_9","from":{"activeSessionId":"act_1","sessionId":"sess_1","sessionName":"root","runtimeKind":"top-level"},"fromRelationship":"child"}"#,
    );
    rt::<CloudCommandRequest>(
        r#"{"kind":"set_model","provider":"prime-inference","modelId":"internal/glm-5.3-fast"}"#,
    );
    rt::<CloudCommandRequest>(r#"{"kind":"set_thinking_level","level":"high"}"#);
    rt::<CloudCommandRequest>(r#"{"kind":"set_session_name","name":"worker"}"#);
    rt::<CloudCommandRequest>(r#"{"kind":"compact","customInstructions":"keep the plan"}"#);
    rt::<CloudCommandRequest>(r#"{"kind":"compact"}"#);
    rt::<CloudCommandRequest>(r#"{"kind":"cancel_child","childId":"rlm_1"}"#);
    rt::<CloudCommandRequest>(r#"{"kind":"delete_child","childId":"rlm_1"}"#);
    rt::<CloudCommandRequest>(
        r#"{"kind":"extension_ui_response","requestId":"ext_1","response":{"choice":"ok"}}"#,
    );
    rt::<CloudCommandRequest>(
        r#"{"kind":"extension_ui_response","requestId":"ext_1","response":"plain text","targetSessionId":"remote_child"}"#,
    );
    rt::<CloudCommandRequest>(
        r#"{"kind":"family_roster_result","requestId":"famreq_1","entries":[{"id":"sess_local","depth":0,"status":"running"}]}"#,
    );
    rt::<CloudCommandRequest>(
        r#"{"kind":"agent_message_result","requestId":"msgreq_1","ok":true,"receipt":{"id":"agentmsg_9","deliveryStatus":"delivered"}}"#,
    );
    rt::<CloudCommandRequest>(
        r#"{"kind":"agent_message_result","requestId":"msgreq_2","ok":false,"error":"unknown target"}"#,
    );
}

#[test]
fn event_round_trips() {
    rt::<CloudEvent>(
        format!(r#"{{"sequence":1,"kind":"command_accepted","recordedAt":"2026-09-29T00:00:00.000Z","receipt":{RECEIPT}}}"#).as_str(),
    );
    rt::<CloudEvent>(
        format!(r#"{{"sequence":2,"kind":"command_state","recordedAt":"2026-09-29T00:00:00.001Z","receipt":{RECEIPT}}}"#).as_str(),
    );
    rt::<CloudEvent>(
        r#"{"sequence":3,"kind":"session_status","recordedAt":"2026-09-29T00:00:00.002Z","status":"starting"}"#,
    );
    rt::<CloudEvent>(
        r#"{"sequence":4,"kind":"output_delta","recordedAt":"2026-09-29T00:00:00.003Z","taskId":"task_1","stream":"stdout","text":"chunk"}"#,
    );
    rt::<CloudEvent>(
        r#"{"sequence":5,"kind":"session_entry","recordedAt":"2026-09-29T00:00:00.004Z","sessionId":"remote_1","entryId":"entry_1","entry":{"type":"message","id":"m1","parentId":null,"timestamp":"2026-09-29T00:00:00.000Z","role":"user"},"artifacts":[{"path":"art://big","sha256":"sha256:e7dfe480c4463263a93755ec83d15829b19df0698e8b764baa4b5e9a3d7bc727","bytes":262145}]}"#,
    );
    rt::<CloudEvent>(
        r#"{"sequence":6,"kind":"session_event","recordedAt":"2026-09-29T00:00:00.005Z","sessionId":"remote_1","event":{"type":"tool_call","name":"bash"}}"#,
    );
    rt::<CloudEvent>(
        r#"{"sequence":7,"kind":"session_meta","recordedAt":"2026-09-29T00:00:00.006Z","sessionId":"remote_1","streaming":true,"runningTools":1,"queue":0,"recap":"working","taskState":"needs_input","model":"prime-inference/internal/glm-5.3-fast","connectivityHints":["tunnel down"]}"#,
    );
    rt::<CloudEvent>(
        r#"{"sequence":8,"kind":"roster_delta","recordedAt":"2026-09-29T00:00:00.007Z","rows":[{"childId":"rlm_1","parentRemoteId":"remote_1","name":"worker","status":"running","depth":1,"preview":"step 2"}]}"#,
    );
    rt::<CloudEvent>(
        r#"{"sequence":9,"kind":"child_update","recordedAt":"2026-09-29T00:00:00.008Z","childId":"rlm_1","status":"completed","answerPreview":"done","sessionFile":"/shadows/remote-child.jsonl","model":"openai/gpt-5.5"}"#,
    );
    rt::<CloudEvent>(
        r#"{"sequence":10,"kind":"usage","recordedAt":"2026-09-29T00:00:00.009Z","sessionId":"remote_1","totals":{"inputTokens":120,"outputTokens":80,"cachedTokens":64,"requests":2},"revision":1}"#,
    );
    rt::<CloudEvent>(
        r#"{"sequence":11,"kind":"family_roster_request","recordedAt":"2026-09-29T00:00:00.010Z","requestId":"famreq_1","fromRemoteSessionId":"remote_root"}"#,
    );
    rt::<CloudEvent>(
        r#"{"sequence":12,"kind":"agent_message_request","recordedAt":"2026-09-29T00:00:00.011Z","requestId":"msgreq_1","fromRemoteSessionId":"remote_child","targetSelector":"sibling-worker","message":"status update"}"#,
    );
}

#[test]
fn cursor_semantics_match_ts() {
    assert!(CloudCursor::new(1, 0).is_ok());
    assert_eq!(
        CloudCursor::new(0, 0).unwrap_err(),
        "cursor generation must be an integer of at least 1"
    );
    assert_eq!(
        CloudCursor::new(1, 0).unwrap().advance(),
        CloudCursor {
            generation: 1,
            sequence: 1
        }
    );
    assert_eq!(
        CloudCursor::new(1, 5)
            .unwrap()
            .at_or_before(CloudCursor::new(1, 5).unwrap()),
        Ok(true)
    );
    assert_eq!(
        CloudCursor::new(1, 6)
            .unwrap()
            .at_or_before(CloudCursor::new(1, 5).unwrap()),
        Ok(false)
    );
    assert_eq!(
        CloudCursor::new(2, 1)
            .unwrap()
            .at_or_before(CloudCursor::new(3, 1).unwrap()),
        Err("cursors from generations 2 and 3 are not comparable".to_string())
    );
}

#[test]
fn model_selector_round_trip() {
    let selector = canonical_cloud_model_selector("prime-inference", "internal/glm-5.3-fast");
    assert_eq!(selector, "prime-inference/internal/glm-5.3-fast");
    assert_eq!(
        split_cloud_model_selector(&selector),
        Some((
            "prime-inference".to_string(),
            "internal/glm-5.3-fast".to_string()
        ))
    );
    assert_eq!(split_cloud_model_selector("noprovider"), None);
    assert_eq!(split_cloud_model_selector("/model"), None);
    assert_eq!(split_cloud_model_selector("provider/"), None);
}

#[test]
fn digest_helpers_match_ts_shape() {
    let digest = cloud_request_digest(&json!({"kind": "prompt", "text": "hi"})).unwrap();
    assert!(is_cloud_digest(&digest));
    assert_eq!(
        digest,
        "sha256:e7dfe480c4463263a93755ec83d15829b19df0698e8b764baa4b5e9a3d7bc727"
    );
    assert!(!is_cloud_digest("sha256:xyz"));
    assert!(!is_cloud_digest(
        "e7dfe480c4463263a93755ec83d15829b19df0698e8b764baa4b5e9a3d7bc727"
    ));
    assert!(!is_cloud_digest(
        "sha256:E7DFE480C4463263A93755EC83D15829B19DF0698E8B764BAA4B5E9A3D7BC727"
    ));
    assert_eq!(
        CLOUD_REQUEST_DIGEST_DOMAIN,
        format!("{CLOUD_PROTOCOL_NAME}.request.v1")
    );
}

#[test]
fn command_state_terminality_matches_ts() {
    assert!(!CloudCommandState::Accepted.is_terminal());
    assert!(!CloudCommandState::Running.is_terminal());
    assert!(CloudCommandState::Completed.is_terminal());
    assert!(CloudCommandState::Failed.is_terminal());
    assert!(CloudCommandState::Cancelled.is_terminal());
}

#[test]
fn codec_round_trip_matches_ts_semantics() {
    let wire = r#"{"type":"hello","protocolVersion":3,"generation":1,"clientId":"client_1","sessionId":"sess_1"}"#;
    let message = parse_cloud_message(wire).unwrap();
    let serialized = serialize_cloud_message(&message).unwrap();
    assert_eq!(
        serialized,
        r#"{"clientId":"client_1","generation":1,"protocolVersion":3,"sessionId":"sess_1","type":"hello"}"#
    );
    let reparsed = parse_cloud_message(&serialized).unwrap();
    assert_eq!(message, reparsed);

    // The not-valid-JSON reason is engine-specific (serde vs V8); only the
    // TS prefix is pinned.
    assert!(parse_cloud_message("{nope")
        .unwrap_err()
        .starts_with("message is not valid JSON: "));
    assert_eq!(
        parse_cloud_message("null").unwrap_err(),
        "message must be a JSON object"
    );
    let oversized = format!("{{\"type\":\"{}\"}}", "x".repeat(CLOUD_MAX_MESSAGE_BYTES));
    assert_eq!(
        parse_cloud_message(&oversized).unwrap_err(),
        format!("message exceeds {CLOUD_MAX_MESSAGE_BYTES} bytes")
    );
}

#[test]
fn serialize_rejects_invalid_messages_with_ts_strings() {
    // Typed layer accepts duplicate sequences (serde is permissive); the
    // validator inside serialize_cloud_message rejects them.
    let wire = r#"{"type":"events","sessionId":"sess_1","generation":1,"events":[{"sequence":1,"kind":"session_status","recordedAt":"2026-09-29T00:00:00.000Z","status":"idle"},{"sequence":1,"kind":"session_status","recordedAt":"2026-09-29T00:00:00.001Z","status":"busy"}]}"#;
    // Bypass the parse validator: the typed layer alone accepts duplicate
    // sequences, and serialize_cloud_message is the gate.
    let message: CloudMessage = serde_json::from_str(wire).unwrap();
    assert_eq!(
        serialize_cloud_message(&message).unwrap_err(),
        "invalid cloud message: events.events[1].sequence must strictly increase"
    );
}

#[test]
fn validator_problem_strings_spot_checks() {
    assert_eq!(
        cloud_id_problem(None, "id").unwrap(),
        "id must be a non-empty string of at most 128 characters"
    );
    assert_eq!(
        cloud_request_problem(&json!("not an object")).unwrap(),
        "request must be a JSON object"
    );
    assert_eq!(
        cloud_request_problem(&json!({"kind": "nope"})).unwrap(),
        format!("request.kind must be one of {CLOUD_COMMAND_KINDS}")
    );
    assert_eq!(
        cloud_request_problem(&json!({"kind": "prompt", "text": ""})).unwrap(),
        "request.text must be a string of 1-65536 characters"
    );
    assert_eq!(
        cloud_event_problem(&json!({"sequence": 0}), "event").unwrap(),
        "event.sequence must be an integer of at least 1"
    );
    assert_eq!(
        cloud_message_problem(&json!({"type": "nope"})).unwrap(),
        format!("message.type must be one of {CLOUD_MESSAGE_TYPES}")
    );
    assert_eq!(
        cloud_message_problem(&json!({"type": "hello", "protocolVersion": 2, "generation": 1, "clientId": "c", "sessionId": "s"})).unwrap(),
        "hello.protocolVersion must equal 3"
    );
    assert_eq!(
        cloud_request_json_problem(&json!({"kind": "prompt", "text": "x".repeat(200_000)}))
            .unwrap(),
        "request exceeds 131072 bytes"
    );
}

/// Deliberate parity, pinned: the pinned TS `submitProblem` validates a
/// submit through `cloudRequestProblem` and the digest only — it never
/// calls `cloudRequestJsonProblem` — so an oversized but per-field-valid
/// request (here a `family_roster_result` under the row cap and the 1 MiB
/// frame cap) is protocol-valid wire input. Wiring the size bound into
/// submit validation would reject frames the TS accepts; the bound stays
/// the submit constructor's invariant.
#[test]
fn oversized_request_passes_submit_validation() {
    let long_path = "p".repeat(CLOUD_MAX_PATH_CHARS);
    let entries: Vec<Value> = (0..24)
        .map(|index| {
            json!({
                "id": format!("sess_{index}"),
                "depth": index,
                "status": "running",
                "sessionPath": long_path,
                "parentSessionPath": long_path,
            })
        })
        .collect();
    let request = json!({
        "kind": "family_roster_result",
        "requestId": "famreq_big",
        "entries": entries,
    });
    let encoded = canonical_json(&request).expect("canonical");
    assert!(
        encoded.len() > CLOUD_MAX_REQUEST_JSON_CHARS,
        "fixture must exceed the request bound"
    );
    assert_eq!(cloud_request_problem(&request), None);
    assert_eq!(
        cloud_request_json_problem(&request).unwrap(),
        "request exceeds 131072 bytes"
    );
    let submit = json!({
        "type": "submit",
        "sessionId": "sess_1",
        "generation": 1,
        "commandId": "cmd_big",
        "request": request,
        "digest": cloud_request_digest(&request).expect("digest"),
    });
    assert_eq!(cloud_message_problem(&submit), None);
}
