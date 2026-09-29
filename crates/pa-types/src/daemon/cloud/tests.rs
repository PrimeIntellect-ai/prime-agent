//! Wire goldens for the cloud family slice: byte-parity round trips, exact
//! TS problem strings, UTF-16 unit bounds at the astral boundary, and
//! canonical JSON stability.

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

const ROSTER_REQUEST: &str = r#"{"sequence":1,"kind":"family_roster_request","recordedAt":"2026-09-29T00:00:00.000Z","requestId":"famreq_1","fromRemoteSessionId":"remote_root"}"#;
const AGENT_MESSAGE_REQUEST: &str = r#"{"sequence":2,"kind":"agent_message_request","recordedAt":"2026-09-29T00:00:00.001Z","requestId":"msgreq_1","fromRemoteSessionId":"remote_child","targetSelector":"sibling-worker","message":"status update"}"#;
const FAMILY_ROW: &str = r#"{"id":"sess_cloud_1","name":"cloud child","depth":1,"status":"running","parentSessionId":"sess_local_1","parentSessionPath":"/sessions/local-1.jsonl","sessionPath":"/shadows/cloud-1.jsonl"}"#;
const ROSTER_RESULT: &str = r#"{"kind":"family_roster_result","requestId":"famreq_1","entries":[{"id":"sess_local_1","depth":0,"status":"running"},{"id":"sess_cloud_1","name":"cloud child","depth":1,"status":"idle","sessionPath":"/shadows/cloud-1.jsonl"}]}"#;
const MESSAGE_RESULT_OK: &str = r#"{"kind":"agent_message_result","requestId":"msgreq_1","ok":true,"receipt":{"id":"agentmsg_9","source":"agent","target":{"activeSessionId":"act_9","sessionId":"sess_9","sessionName":"sibling-worker","runtimeKind":"top-level"},"message":"status update","deliveryStatus":"delivered","deliveredAt":"2026-09-29T00:00:01.000Z","deliveryMode":"steer","receiverRole":"sibling"}}"#;
const MESSAGE_RESULT_ERR: &str = r#"{"kind":"agent_message_result","requestId":"msgreq_2","ok":false,"error":"Unknown cloud message source: remote_x"}"#;

#[test]
fn wire_round_trips() {
    rt::<CloudFamilyInfo>(
        r#"{"depth":2,"parentSessionId":"sess_local_1","parentSessionFile":"/sessions/local-1.jsonl","parentName":"worker"}"#,
    );
    rt::<CloudFamilyInfo>(
        r#"{"depth":1,"parentSessionId":"sess_local_1","parentSessionFile":"/sessions/local-1.jsonl"}"#,
    );
    rt::<CloudAgentMessageSender>(
        r#"{"activeSessionId":"act_1","sessionId":"sess_1","sessionName":"worker","runtimeKind":"top-level"}"#,
    );
    rt::<CloudAgentMessageSender>(r#"{"runtimeKind":"subagent"}"#);
    rt::<CloudFamilyRow>(FAMILY_ROW);
    rt::<CloudFamilyRow>(r#"{"id":"sess_local_1","depth":0,"status":"idle"}"#);
    rt::<CloudFamilyEvent>(ROSTER_REQUEST);
    rt::<CloudFamilyEvent>(AGENT_MESSAGE_REQUEST);
    rt::<CloudFamilyCommand>(ROSTER_RESULT);
    rt::<CloudFamilyCommand>(MESSAGE_RESULT_OK);
    rt::<CloudFamilyCommand>(MESSAGE_RESULT_ERR);
}

#[test]
fn request_id_and_journal_command_id_conventions() {
    let roster: CloudFamilyEvent = serde_json::from_str(ROSTER_REQUEST).unwrap();
    assert_eq!(roster.request_id(), "famreq_1");
    let message: CloudFamilyEvent = serde_json::from_str(AGENT_MESSAGE_REQUEST).unwrap();
    assert_eq!(message.request_id(), "msgreq_1");

    let roster_result: CloudFamilyCommand = serde_json::from_str(ROSTER_RESULT).unwrap();
    assert_eq!(roster_result.journal_command_id(), "fam_famreq_1");
    let message_result: CloudFamilyCommand = serde_json::from_str(MESSAGE_RESULT_OK).unwrap();
    assert_eq!(message_result.journal_command_id(), "msgres_msgreq_1");
}

#[test]
fn send_message_wire_value_carries_the_kind_tag() {
    let request = CloudSendMessageRequest {
        target_remote_session_id: "remote_child".to_string(),
        message: "status update".to_string(),
        message_id: Some("agentmsg_9".to_string()),
        from: Some(CloudAgentMessageSender {
            active_session_id: Some("act_1".to_string()),
            session_id: Some("sess_1".to_string()),
            session_name: None,
            runtime_kind: Some(CloudRuntimeKind::TopLevel),
        }),
        from_relationship: Some(CloudFamilyRelationship::Child),
    };
    let value = request.wire_value().unwrap();
    assert_eq!(value["kind"], json!("send_message"));
    assert_eq!(value["targetRemoteSessionId"], json!("remote_child"));
    assert_eq!(value["fromRelationship"], json!("child"));
    assert_eq!(value["from"]["runtimeKind"], json!("top-level"));
}

#[test]
fn protocol_constants_match_ts() {
    assert_eq!(CLOUD_PROTOCOL_NAME, "prime-agent.cloud");
    assert_eq!(CLOUD_PROTOCOL_VERSION, 3);
    assert_eq!(CLOUD_CAPABILITY_FAMILY_MESSAGES, "family_messages");
    assert_eq!(CLOUD_MAX_FAMILY_ROWS, 64);
    assert_eq!(CLOUD_MAX_SELECTOR_CHARS, 128);
    assert_eq!(CLOUD_MAX_RECEIPT_RESULT_CHARS, 2048);
    assert_eq!(CLOUD_MAX_PROMPT_CHARS, 65_536);
    assert_eq!(
        CLOUD_EVENT_KINDS,
        "command_accepted, command_state, session_status, output_delta, session_entry, session_event, session_meta, roster_delta, child_update, usage, family_roster_request, agent_message_request"
    );
    assert_eq!(
        CLOUD_COMMAND_KINDS,
        "open_session, prompt, steer, follow_up, abort, send_message, set_model, set_thinking_level, set_session_name, compact, cancel_child, delete_child, extension_ui_response, release, family_roster_result, agent_message_result"
    );
}

#[test]
fn canonical_json_sorts_keys_and_preserves_array_order() {
    assert_eq!(
        canonical_json(&json!({"b":1,"a":{"d":[3,1,2],"c":null}})).unwrap(),
        r#"{"a":{"c":null,"d":[3,1,2]},"b":1}"#
    );
    // TS normalizes -0 to 0.
    let negative_zero: Value = serde_json::from_str("-0.0").unwrap();
    assert_eq!(canonical_json(&negative_zero).unwrap(), "0");
    assert_eq!(canonical_json(&json!("quote\"")).unwrap(), r#""quote\"""#);
}

#[test]
fn canonical_json_renders_numbers_like_javascript() {
    // TS digests are computed over `String(number)` bytes; serde_json's own
    // rendering diverges on integral floats, -0, and plain-decimal-range
    // magnitudes, so the parity cases here pin the JS-exact rendering.
    let cases = [
        ("2.0", "2"),
        ("0.5", "0.5"),
        ("-0", "0"),
        ("1e21", "1e+21"),
        ("1e-7", "1e-7"),
        ("1e20", "100000000000000000000"),
        // JSON integers beyond 2^53 round through f64, exactly like JS
        // JSON.parse.
        ("9007199254740993", "9007199254740992"),
        ("-9007199254740993", "-9007199254740992"),
        ("2.5", "2.5"),
        ("3.14159", "3.14159"),
    ];
    for (source, expected) in cases {
        let value: Value = serde_json::from_str(&format!("{{\"n\":{source}}}")).unwrap();
        assert_eq!(
            canonical_json(&value).unwrap(),
            format!("{{\"n\":{expected}}}"),
            "source {source}"
        );
    }
}

#[test]
fn canonical_json_depth_bound() {
    let mut value = json!(1);
    for _ in 0..(CLOUD_MAX_JSON_DEPTH + 2) {
        value = json!([value]);
    }
    let problem = canonical_json(&value).unwrap_err();
    assert_eq!(problem, "canonical JSON depth exceeds 64");
}

fn problem(value: &Value) -> Option<String> {
    cloud_family_event_problem(value, "event")
}

#[test]
fn event_validation_problem_strings_match_ts() {
    // Missing recordedAt reports before the kind check, exactly like the TS
    // validator's base problem order.
    assert_eq!(
        problem(&json!({"sequence": 1})).unwrap(),
        "event.recordedAt must be a string of 1-64 characters"
    );
    assert_eq!(problem(&json!({"sequence": 1, "recordedAt": "x"})).unwrap(),
        "event.kind must be one of command_accepted, command_state, session_status, output_delta, session_entry, session_event, session_meta, roster_delta, child_update, usage, family_roster_request, agent_message_request");
    assert_eq!(
        problem(&json!({"sequence": 0, "kind": "family_roster_request", "recordedAt": "x", "requestId": "f", "fromRemoteSessionId": "r"}))
            .unwrap(),
        "event.sequence must be an integer of at least 1"
    );
    assert_eq!(
        problem(&json!({"sequence": 1, "kind": "family_roster_request", "recordedAt": "x", "requestId": "", "fromRemoteSessionId": "r"}))
            .unwrap(),
        "event.requestId must be a string of 1-128 characters"
    );
    assert_eq!(
        problem(&json!({"sequence": 1, "kind": "family_roster_request", "recordedAt": "x", "requestId": "f", "fromRemoteSessionId": "r", "extra": 1}))
            .unwrap(),
        "unexpected field: extra"
    );
    assert_eq!(
        problem(&json!({"sequence": 1, "kind": "agent_message_request", "recordedAt": "x", "requestId": "f", "fromRemoteSessionId": "r", "targetSelector": "s", "message": ""}))
            .unwrap(),
        "event.message must be a string of 1-65536 characters"
    );
    // Known non-family kinds are out of this slice's scope.
    assert!(problem(
        &json!({"sequence": 1, "kind": "session_status", "recordedAt": "x", "status": "idle"})
    )
    .unwrap()
    .starts_with("event.kind must be one of"));
}

#[test]
fn selector_bound_counts_utf16_units_like_ts_length() {
    // 64 astral characters = 128 UTF-16 units: at the bound, valid in TS.
    let at_bound = "\u{1F600}".repeat(64);
    assert_eq!(at_bound.encode_utf16().count(), CLOUD_MAX_SELECTOR_CHARS);
    let at_bound_event = json!({
        "sequence": 1, "kind": "agent_message_request", "recordedAt": "x",
        "requestId": "f", "fromRemoteSessionId": "r",
        "targetSelector": at_bound, "message": "m",
    });
    assert_eq!(problem(&at_bound_event), None);

    // 64 astral + one BMP character = 129 units: over the bound in TS too.
    let over = format!("{at_bound}x");
    assert_eq!(over.encode_utf16().count(), CLOUD_MAX_SELECTOR_CHARS + 1);
    let over_event = json!({
        "sequence": 1, "kind": "agent_message_request", "recordedAt": "x",
        "requestId": "f", "fromRemoteSessionId": "r",
        "targetSelector": over, "message": "m",
    });
    assert_eq!(
        problem(&over_event).unwrap(),
        "event.targetSelector must be a string of 1-128 characters"
    );
}

#[test]
fn message_bound_counts_utf16_units() {
    let astral_at_bound = "\u{1F600}".repeat(CLOUD_MAX_PROMPT_CHARS / 2);
    assert_eq!(
        astral_at_bound.encode_utf16().count(),
        CLOUD_MAX_PROMPT_CHARS
    );
    let event = json!({
        "sequence": 1, "kind": "agent_message_request", "recordedAt": "x",
        "requestId": "f", "fromRemoteSessionId": "r",
        "targetSelector": "s", "message": astral_at_bound,
    });
    assert_eq!(problem(&event), None);
}

fn command_problem(value: &Value) -> Option<String> {
    cloud_family_command_problem(value, "request")
}

#[test]
fn command_validation_problem_strings_match_ts() {
    assert_eq!(
        command_problem(
            &json!({"kind": "family_roster_result", "requestId": "f", "entries": {"id": "x"}})
        )
        .unwrap(),
        "request.entries must be an array"
    );
    assert_eq!(
        command_problem(&json!({"kind": "family_roster_result", "requestId": "f", "entries": []})),
        None
    );
    assert_eq!(
        command_problem(&json!({"kind": "agent_message_result", "requestId": "f", "ok": true}))
            .unwrap(),
        "request.receipt is required when ok is true"
    );
    assert_eq!(
        command_problem(&json!({
            "kind": "agent_message_result", "requestId": "f", "ok": false,
            "error": "x", "receipt": {"id": "a"},
        }))
        .unwrap(),
        "request.receipt must be omitted when ok is false"
    );
    assert_eq!(
        command_problem(&json!({"kind": "agent_message_result", "requestId": "f", "ok": "yes"}))
            .unwrap(),
        "request.ok must be a boolean"
    );
    assert_eq!(
        command_problem(&json!({
            "kind": "agent_message_result", "requestId": "f", "ok": true,
            "receipt": {"id": "a", "deliveryStatus": "delivered", "padded": "x".repeat(2048)},
        }))
        .unwrap(),
        "request.receipt exceeds 2048 bytes"
    );
    assert_eq!(
        command_problem(&json!({"kind": "release"})).unwrap(),
        format!("request.kind must be one of {CLOUD_COMMAND_KINDS}")
    );
}

#[test]
fn family_rows_and_sender_validation() {
    let mut rows: Vec<Value> = Vec::new();
    for index in 0..=CLOUD_MAX_FAMILY_ROWS {
        rows.push(json!({"id": format!("sess_{index}"), "depth": 0, "status": "running"}));
    }
    assert_eq!(
        cloud_family_rows_problem(&json!(rows), "request.entries").unwrap(),
        "request.entries must hold at most 64 entries"
    );
    assert_eq!(
        cloud_family_rows_problem(
            &json!([{"id": "a", "depth": -1, "status": "running"}]),
            "request.entries"
        )
        .unwrap(),
        "request.entries[0].depth must be an integer of at least 0"
    );
    assert_eq!(
        cloud_family_rows_problem(
            &json!([{"id": "a", "depth": 0, "status": "paused"}]),
            "request.entries"
        )
        .unwrap(),
        "request.entries[0].status must be one of running, idle, inactive"
    );
    assert_eq!(
        cloud_agent_message_sender_problem(&json!({"runtimeKind": "child"}), "request.from")
            .unwrap(),
        "request.from.runtimeKind must be one of top-level, subagent"
    );
    assert_eq!(
        cloud_agent_message_sender_problem(&json!({}), "request.from"),
        None
    );
}

#[test]
fn family_info_and_send_message_validation() {
    assert_eq!(
        cloud_family_info_problem(
            &json!({"depth": 0, "parentSessionId": "p", "parentSessionFile": "/p"}),
            "request.family"
        )
        .unwrap(),
        "request.family.depth must be an integer of at least 1"
    );
    assert_eq!(
        cloud_family_info_problem(
            &json!({"depth": 1, "parentSessionId": "p"}),
            "request.family"
        )
        .unwrap(),
        "request.family.parentSessionFile must be a string of 1-4096 characters"
    );
    assert_eq!(
        cloud_family_info_problem(
            &json!({"depth": 1, "parentSessionId": "p", "parentSessionFile": "/p", "parentName": "w"}),
            "request.family"
        ),
        None
    );
    assert_eq!(
        cloud_send_message_problem(
            &json!({"kind": "send_message", "targetRemoteSessionId": "r", "message": "m"}),
            "request"
        ),
        None
    );
    assert_eq!(
        cloud_send_message_problem(&json!({"kind": "send_message", "message": "m"}), "request")
            .unwrap(),
        "request.targetRemoteSessionId must be a string of 1-128 characters"
    );
    assert_eq!(
        cloud_send_message_problem(
            &json!({"kind": "send_message", "targetRemoteSessionId": "r", "message": "m", "fromRelationship": "cousin"}),
            "request"
        ).unwrap(),
        "request.fromRelationship must be one of parent, sibling, child"
    );
}

#[test]
fn receipt_canonical_problem_bounds() {
    let receipt = CloudAgentMessageReceipt {
        id: Some("agentmsg_9".to_string()),
        delivery_status: Some(CloudAgentMessageDeliveryStatus::Delivered),
        rest: serde_json::from_str(r#"{"source":"agent","message":"m","deliveryMode":"steer"}"#)
            .unwrap(),
    };
    assert_eq!(receipt.canonical_problem(), None);

    let oversized = CloudAgentMessageReceipt {
        id: Some("agentmsg_9".to_string()),
        delivery_status: Some(CloudAgentMessageDeliveryStatus::Queued),
        rest: {
            let mut map = serde_json::Map::new();
            map.insert("padded".to_string(), json!("x".repeat(2048)));
            map
        },
    };
    assert_eq!(
        oversized.canonical_problem().unwrap(),
        "request.receipt exceeds 2048 bytes"
    );
}

/// The wire domain of an `agent_message_result` receipt is any
/// canonical-JSON object (TS `cloudRequestProblem`; the empty object is
/// protocol-valid — the TS-recorded corpus case
/// `agent_message_result_ok_empty_receipt` pins it), so the typed carrier
/// deserializes every object, extracts the deliverer's `id` /
/// `deliveryStatus` only when present and well-formed, and keeps
/// everything else verbatim in `rest`.
#[test]
fn receipt_carries_the_protocol_domain() {
    rt::<CloudFamilyCommand>(
        r#"{"kind":"agent_message_result","requestId":"msgreq_3","ok":true,"receipt":{}}"#,
    );
    rt::<CloudFamilyCommand>(
        r#"{"kind":"agent_message_result","requestId":"msgreq_4","ok":true,"receipt":{"id":42,"deliveryStatus":"bogus","note":"kept"}}"#,
    );

    let empty: CloudFamilyCommand = serde_json::from_str(
        r#"{"kind":"agent_message_result","requestId":"msgreq_3","ok":true,"receipt":{}}"#,
    )
    .unwrap();
    let CloudFamilyCommandPayload::AgentMessageResult {
        receipt: Some(empty),
        ..
    } = empty.payload
    else {
        panic!("agent_message_result payload");
    };
    assert_eq!(empty.id, None);
    assert_eq!(empty.delivery_status, None);
    assert_eq!(Value::Object(empty.rest), json!({}));

    let mistyped: CloudFamilyCommand = serde_json::from_str(
        r#"{"kind":"agent_message_result","requestId":"msgreq_4","ok":true,"receipt":{"id":42,"deliveryStatus":"bogus","note":"kept"}}"#,
    )
    .unwrap();
    let CloudFamilyCommandPayload::AgentMessageResult {
        receipt: Some(mistyped),
        ..
    } = mistyped.payload
    else {
        panic!("agent_message_result payload");
    };
    assert_eq!(mistyped.id, None);
    assert_eq!(mistyped.delivery_status, None);
    assert_eq!(
        Value::Object(mistyped.rest),
        json!({"id": 42, "deliveryStatus": "bogus", "note": "kept"})
    );

    let real: CloudFamilyCommand = serde_json::from_str(MESSAGE_RESULT_OK).unwrap();
    let CloudFamilyCommandPayload::AgentMessageResult {
        receipt: Some(real),
        ..
    } = real.payload
    else {
        panic!("agent_message_result payload");
    };
    assert_eq!(real.id.as_deref(), Some("agentmsg_9"));
    assert_eq!(
        real.delivery_status,
        Some(CloudAgentMessageDeliveryStatus::Delivered)
    );
}
